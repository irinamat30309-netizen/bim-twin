'use strict';
/**
 * Ревизия 51: уплотнение готового облака точками сырого лидара (.xbin).
 * Сверка с Lixel Studio (фасад, окно 120 с): прошивка сканера кладёт в map.las ~129 тыс. точек/с, сырой лидар — ~294 тыс./с,
 * у Lixel на фасаде 3,4 тыс. точек на 0,5 × 0,5 м против 1,3 тыс. у нашей карты: между точками карты — пустоты, которые на экране
 * видны как тёмная «крапинка». Сырые точки сами по себе шумные (толщина стены 27 мм против 3,7 мм у обработанной карты),
 * поэтому они не добавляются как есть: каждая прижимается к местной плоскости опоры — готового облака из того же отрезка времени
 * (взвешенная плоскость соседей в шаре R, только на ровных местах: кривизна < curv, расстояние до плоскости < maxD).
 * Перед этим на каждом отрезке подбирается общий сдвиг сырых точек к опоре (точка-к-плоскости, как один шаг ICP).
 * Точка добавляется только в пустую ячейку cell (5 мм: до ~40 тыс. точек на м² плоскости при ~36 тыс. у Lixel на фасаде; ячейки общие для всей съёмки — globalOcc) — облако становится ровно плотным, а не «вдвое больше везде».
 * Цвет новой точки — гауссово среднее цвета опоры по расстоянию вдоль поверхности (σ sigC), прочие поля — от ближайшей точки опоры,
 * время — своё. Кромки, провода, углы (кривизна выше curv) и места без опоры не трогаются — там остаются только точки опоры.
 */
const fs = require('node:fs');
const path = require('node:path');
const R = require('./scan-refine-core');
const { buildGrid, hashCell } = require('./xbin-refine');

const DEF = { R: 0.035, sig: 0.02, minN: 8, curv: 0.08, maxD: 0.035, cell: 0.005, sigC: 0.01, align: true, alignMaxD: 0.08, alignMax: 0.05, alignSample: 20000, minAlign: 500,
  chunk: 10, margin: 3, planeCell: 0.015, occBits: 26 };

/** Наименьший собственный вектор симметричной 3×3 (аналитически): out ← нормаль, возврат — наименьшее собственное число. */
function minEig(a, b, c, d, e, f, out) {
  // [[a b c][b d e][c e f]]
  const p1 = b * b + c * c + e * e, q = (a + d + f) / 3;
  let l;
  if (p1 < 1e-30) { l = Math.min(a, d, f); out[0] = l === a ? 1 : 0; out[1] = l === a ? 0 : (l === d ? 1 : 0); out[2] = (l !== a && l !== d) ? 1 : 0; return l; }
  const p2 = (a - q) * (a - q) + (d - q) * (d - q) + (f - q) * (f - q) + 2 * p1, p = Math.sqrt(p2 / 6);
  const B0 = (a - q) / p, B1 = b / p, B2 = c / p, B3 = (d - q) / p, B4 = e / p, B5 = (f - q) / p;
  let r = (B0 * (B3 * B5 - B4 * B4) - B1 * (B1 * B5 - B4 * B2) + B2 * (B1 * B4 - B3 * B2)) / 2;
  r = r <= -1 ? -1 : (r >= 1 ? 1 : r);
  const phi = Math.acos(r) / 3;
  l = q + 2 * p * Math.cos(phi + 2 * Math.PI / 3);
  // вектор: наибольшее векторное произведение строк (A − lI)
  const r0x = a - l, r0y = b, r0z = c, r1x = b, r1y = d - l, r1z = e, r2x = c, r2y = e, r2z = f - l;
  let x0 = r0y * r1z - r0z * r1y, y0 = r0z * r1x - r0x * r1z, z0 = r0x * r1y - r0y * r1x;
  const x1 = r0y * r2z - r0z * r2y, y1 = r0z * r2x - r0x * r2z, z1 = r0x * r2y - r0y * r2x;
  const x2 = r1y * r2z - r1z * r2y, y2 = r1z * r2x - r1x * r2z, z2 = r1x * r2y - r1y * r2x;
  let n0 = x0 * x0 + y0 * y0 + z0 * z0; const n1 = x1 * x1 + y1 * y1 + z1 * z1, n2 = x2 * x2 + y2 * y2 + z2 * z2;
  if (n1 > n0) { x0 = x1; y0 = y1; z0 = z1; n0 = n1; }
  if (n2 > n0) { x0 = x2; y0 = y2; z0 = z2; n0 = n2; }
  if (!(n0 > 0)) { out[0] = 0; out[1] = 0; out[2] = 1; return l; }
  const s = 1 / Math.sqrt(n0); out[0] = x0 * s; out[1] = y0 * s; out[2] = z0 * s; return l;
}

/**
 * snap(GX, gn, GRGB, QX, qm, opt) — прижать сырые точки QX (xyz подряд, qm штук) к опоре GX (gn штук, цвет GRGB или null).
 * → { P (xyz новых), C (цвет), nb (ближайшая точка опоры), src (номер сырой точки), k, shift, stats }
 */
function snap(GX, gn, GRGB, QX, qm, opt) {
  const o = Object.assign({}, DEF, opt || {});
  const st = { raw: qm, none: 0, curv: 0, far: 0, dup: 0, kept: 0, alignN: 0 };
  const shift = [0, 0, 0];
  if (!gn || !qm) return { P: new Float64Array(0), C: null, nb: new Int32Array(0), src: new Int32Array(0), k: 0, shift, stats: st };
  const X = new Float64Array(gn), Y = new Float64Array(gn), Z = new Float64Array(gn);
  for (let i = 0; i < gn; i++) { X[i] = GX[i * 3]; Y[i] = GX[i * 3 + 1]; Z[i] = GX[i * 3 + 2]; }
  const G = buildGrid(X, Y, Z, gn, o.R, null), cs = G.cell, mask = G.mask, idx = G.idx, start = G.start;
  const R2 = o.R * o.R, s2 = 2 * o.sig * o.sig, nrm = new Float64Array(3);
  let fx = 0, fy = 0, fz = 0, fd = 0, fb = -1, fc = 0, fcurv = 0;   // итог fit: нормаль, расстояние (p − μ)·n, ближайшая, соседи, кривизна
  const fit = (x, y, z) => {
    const cx = Math.floor(x / cs), cy = Math.floor(y / cs), cz = Math.floor(z / cs);
    let sw = 0, mx = 0, my = 0, mz = 0, xx = 0, xy = 0, xz = 0, yy = 0, yz = 0, zz = 0, best = Infinity, bi = -1, cnt = 0;
    for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) for (let dz = -1; dz <= 1; dz++) {
      const h = hashCell(cx + dx, cy + dy, cz + dz, mask);
      for (let s = start[h], e = start[h + 1]; s < e; s++) {
        const j = idx[s], ex = X[j] - x, ey = Y[j] - y, ez = Z[j] - z, d2 = ex * ex + ey * ey + ez * ez;
        if (d2 > R2) continue;
        const w = Math.exp(-d2 / s2); sw += w; cnt++;
        mx += w * ex; my += w * ey; mz += w * ez; xx += w * ex * ex; xy += w * ex * ey; xz += w * ex * ez; yy += w * ey * ey; yz += w * ey * ez; zz += w * ez * ez;
        if (d2 < best) { best = d2; bi = j; }
      }
    }
    fc = cnt; fb = bi;
    if (cnt < o.minN) return 1;
    mx /= sw; my /= sw; mz /= sw;
    const a = xx / sw - mx * mx, b = xy / sw - mx * my, c = xz / sw - mx * mz, d = yy / sw - my * my, e = yz / sw - my * mz, f = zz / sw - mz * mz, tr = a + d + f;
    if (!(tr > 0)) return 1;
    const lam = minEig(a, b, c, d, e, f, nrm); fcurv = lam / tr;
    if (!(fcurv < o.curv)) return 2;
    fx = nrm[0]; fy = nrm[1]; fz = nrm[2]; fd = -(mx * fx + my * fy + mz * fz);
    return 0;
  };
  // 1) общий сдвиг сырых точек к опоре: (Σ n nᵀ + λI) t = −Σ n d, два прохода (второй — без дальних)
  if (o.align && qm >= o.minAlign) {
    const step = Math.max(1, Math.floor(qm / o.alignSample));
    for (let pass = 0; pass < 2; pass++) {
      let A00 = 0, A01 = 0, A02 = 0, A11 = 0, A12 = 0, A22 = 0, b0 = 0, b1 = 0, b2 = 0, n = 0;
      const lim = pass ? Math.min(o.maxD, o.alignMaxD) : o.alignMaxD;
      for (let i = 0; i < qm; i += step) {
        const x = QX[i * 3] + shift[0], y = QX[i * 3 + 1] + shift[1], z = QX[i * 3 + 2] + shift[2];
        if (fit(x, y, z) || Math.abs(fd) > lim) continue;
        A00 += fx * fx; A01 += fx * fy; A02 += fx * fz; A11 += fy * fy; A12 += fy * fz; A22 += fz * fz; b0 -= fx * fd; b1 -= fy * fd; b2 -= fz * fd; n++;
      }
      st.alignN = n; if (n < o.minAlign / 5) break;
      const lam = 0.05 * n; A00 += lam; A11 += lam; A22 += lam;
      // решение 3×3 (Крамер)
      const det = A00 * (A11 * A22 - A12 * A12) - A01 * (A01 * A22 - A12 * A02) + A02 * (A01 * A12 - A11 * A02);
      if (!(Math.abs(det) > 1e-30)) break;
      const t0 = (b0 * (A11 * A22 - A12 * A12) - A01 * (b1 * A22 - A12 * b2) + A02 * (b1 * A12 - A11 * b2)) / det;
      const t1 = (A00 * (b1 * A22 - A12 * b2) - b0 * (A01 * A22 - A12 * A02) + A02 * (A01 * b2 - b1 * A02)) / det;
      const t2 = (A00 * (A11 * b2 - b1 * A12) - A01 * (A01 * b2 - b1 * A02) + b0 * (A01 * A12 - A11 * A02)) / det;
      shift[0] += t0; shift[1] += t1; shift[2] += t2;
      const L = Math.hypot(shift[0], shift[1], shift[2]); if (L > o.alignMax) { const s = o.alignMax / L; shift[0] *= s; shift[1] *= s; shift[2] *= s; }
    }
  }
  // 2) занятые ячейки cell: опора + уже добавленные (хеш-битовая карта; совпадение хешей — точка просто не добавляется)
  const OB = Math.max(16, Math.min(30, o.occBits | 0)), om = (1 << OB) - 1 >>> 0, occ = new Uint32Array(((1 << OB) >>> 5) || 1), cc = o.cell;
  const okey = (x, y, z) => hashCell(Math.floor(x / cc), Math.floor(y / cc), Math.floor(z / cc), 0x7fffffff) & om;
  for (let i = 0; i < gn; i++) { const k = okey(X[i], Y[i], Z[i]); occ[k >>> 5] |= 1 << (k & 31); }
  let cap = Math.min(qm, 1 << 20), P = new Float64Array(cap * 3), nb = new Int32Array(cap), src = new Int32Array(cap), C = GRGB ? new Float32Array(cap * 3) : null, k = 0;
  const sc2 = 2 * o.sigC * o.sigC;
  // плоскость опоры — одна на клетку planeCell (считается в центре клетки): сырых точек в клетке много, соседи у них общие
  const PC = o.planeCell > 0 ? o.planeCell : 0, PS = 131072, PH = PC ? new Map() : null;
  let pmx = 0, pmy = 0, pmz = 0;
  for (let i = 0; i < qm; i++) {
    const x = QX[i * 3] + shift[0], y = QX[i * 3 + 1] + shift[1], z = QX[i * 3 + 2] + shift[2];
    let r;
    if (PC) {
      const ix = Math.floor(x / PC) + 65536, iy = Math.floor(y / PC) + 65536, iz = Math.floor(z / PC) + 65536;
      if (ix >= 0 && iy >= 0 && iz >= 0 && ix < PS && iy < PS && iz < PS) {
        const key = ix + PS * (iy + PS * iz); let v = PH.get(key);
        if (v === undefined) {
          const cx = (ix - 65536 + 0.5) * PC, cy = (iy - 65536 + 0.5) * PC, cz = (iz - 65536 + 0.5) * PC, rr = fit(cx, cy, cz);
          // сохраняется точка плоскости μ = c − d·n (d — расстояние центра клетки до плоскости)
          v = rr ? [rr] : [0, fx, fy, fz, cx - fd * fx, cy - fd * fy, cz - fd * fz, fb]; PH.set(key, v);
        }
        r = v[0];
        if (!r) { fx = v[1]; fy = v[2]; fz = v[3]; fd = (x - v[4]) * fx + (y - v[5]) * fy + (z - v[6]) * fz; fb = v[7]; }
      } else r = fit(x, y, z);
    } else r = fit(x, y, z);
    void pmx; void pmy; void pmz;
    if (r === 1) { st.none++; continue; } if (r === 2) { st.curv++; continue; }
    if (Math.abs(fd) > o.maxD) { st.far++; continue; }
    const px = x - fd * fx, py = y - fd * fy, pz = z - fd * fz, ok = okey(px, py, pz);
    if (occ[ok >>> 5] & (1 << (ok & 31))) { st.dup++; continue; }
    occ[ok >>> 5] |= 1 << (ok & 31);
    if (k >= cap) { cap *= 2; const P2 = new Float64Array(cap * 3); P2.set(P); P = P2; const n2 = new Int32Array(cap); n2.set(nb); nb = n2; const s3 = new Int32Array(cap); s3.set(src); src = s3; if (C) { const C2 = new Float32Array(cap * 3); C2.set(C); C = C2; } }
    P[k * 3] = px; P[k * 3 + 1] = py; P[k * 3 + 2] = pz; nb[k] = fb; src[k] = i;
    if (C) {   // цвет: гаусс по расстоянию вдоль поверхности, только соседи у самой плоскости
      const cx = Math.floor(px / cs), cy = Math.floor(py / cs), cz = Math.floor(pz / cs);
      let sw = 0, r0 = 0, g0 = 0, b0 = 0;
      for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) for (let dz = -1; dz <= 1; dz++) {
        const h = hashCell(cx + dx, cy + dy, cz + dz, mask);
        for (let s = start[h], e = start[h + 1]; s < e; s++) {
          const j = idx[s], ex = X[j] - px, ey = Y[j] - py, ez = Z[j] - pz, dn = ex * fx + ey * fy + ez * fz;
          if (dn > 0.01 || dn < -0.01) continue;
          const dt2 = ex * ex + ey * ey + ez * ez - dn * dn; if (dt2 > R2) continue;
          const w = Math.exp(-dt2 / sc2); sw += w; r0 += w * GRGB[j * 3]; g0 += w * GRGB[j * 3 + 1]; b0 += w * GRGB[j * 3 + 2];
        }
      }
      if (sw > 1e-6) { C[k * 3] = r0 / sw; C[k * 3 + 1] = g0 / sw; C[k * 3 + 2] = b0 / sw; }
      else { C[k * 3] = GRGB[fb * 3]; C[k * 3 + 1] = GRGB[fb * 3 + 1]; C[k * 3 + 2] = GRGB[fb * 3 + 2]; }
    }
    k++;
  }
  st.kept = k;
  return { P: P.subarray(0, k * 3), C: C ? C.subarray(0, k * 3) : null, nb: nb.subarray(0, k), src: src.subarray(0, k), k, shift, stats: st };
}

/**
 * Отрезок времени c (номер = ⌊t / chunk⌋): опора — точки отрезков c ± margin из временных файлов (только в клетках 0,5 м, где есть
 * сырые точки отрезка), прижатые точки — записями LAS в OB через put(). Возврат — итоги отрезка.
 */
function processChunk(ctx, c, Rw, put) {
  const { H, tmp, o } = ctx, rl = H.rl, rgb = H.rgb, tOff = H.tOff;
  const st = { raw: Rw.n, none: 0, curv: 0, far: 0, dup: 0, kept: 0, shift: 0 };
  const parts = []; for (let d = -o.margin; d <= o.margin; d++) { const f = path.join(tmp, (c + d) + '.g'); if (fs.existsSync(f)) parts.push(fs.readFileSync(f)); }
  if (!parts.length) { st.none = Rw.n; return st; }
  const GB0 = parts.length > 1 ? Buffer.concat(parts) : parts[0];
  const ox = Rw.ox, oy = Rw.oy, oz = Rw.oz, VC = 0.5, vs = new Set(), m = o.R / VC;
  for (let i = 0; i < Rw.n; i++) vs.add(hashCell(Math.floor(Rw.X[i * 3] / VC), Math.floor(Rw.X[i * 3 + 1] / VC), Math.floor(Rw.X[i * 3 + 2] / VC), 0x3fffffff));
  const n0 = GB0.length / rl, keep = new Int32Array(n0); let gn = 0;
  for (let i = 0, p = 0; i < n0; i++, p += rl) {
    const x = GB0.readInt32LE(p) * H.sx + H.ox - ox, y = GB0.readInt32LE(p + 4) * H.sy + H.oy - oy, z = GB0.readInt32LE(p + 8) * H.sz + H.oz - oz;
    const ix = Math.floor(x / VC), iy = Math.floor(y / VC), iz = Math.floor(z / VC), fx = x / VC - ix, fy = y / VC - iy, fz = z / VC - iz;
    const ax = fx < m ? -1 : (fx > 1 - m ? 1 : 0), ay = fy < m ? -1 : (fy > 1 - m ? 1 : 0), az = fz < m ? -1 : (fz > 1 - m ? 1 : 0);
    let hit = false;
    for (let dx = 0; !hit && dx <= (ax ? 1 : 0); dx++) for (let dy = 0; !hit && dy <= (ay ? 1 : 0); dy++) for (let dz = 0; !hit && dz <= (az ? 1 : 0); dz++)
      if (vs.has(hashCell(ix + dx * ax, iy + dy * ay, iz + dz * az, 0x3fffffff))) hit = true;
    if (hit) keep[gn++] = i;
  }
  if (!gn) { st.none = Rw.n; return st; }
  const GB = Buffer.allocUnsafe(gn * rl); for (let k = 0; k < gn; k++) GB0.copy(GB, k * rl, keep[k] * rl, keep[k] * rl + rl);
  const GX = new Float64Array(gn * 3), GC = rgb !== undefined ? new Float32Array(gn * 3) : null;
  for (let i = 0, p = 0; i < gn; i++, p += rl) {
    GX[i * 3] = GB.readInt32LE(p) * H.sx + H.ox - ox; GX[i * 3 + 1] = GB.readInt32LE(p + 4) * H.sy + H.oy - oy; GX[i * 3 + 2] = GB.readInt32LE(p + 8) * H.sz + H.oz - oz;
    if (GC) for (let a = 0; a < 3; a++) GC[i * 3 + a] = GB.readUInt16LE(p + rgb + a * 2);
  }
  // сырые точки дальше R от любой клетки 0,5 м с опорой — сразу мимо (небо, даль, места без опоры): fit для них не нужен
  const gs = new Set();
  for (let i = 0; i < gn; i++) gs.add(hashCell(Math.floor(GX[i * 3] / VC), Math.floor(GX[i * 3 + 1] / VC), Math.floor(GX[i * 3 + 2] / VC), 0x3fffffff));
  const near = new Int32Array(Rw.n); let qn = 0;
  for (let i = 0; i < Rw.n; i++) {
    const x = Rw.X[i * 3], y = Rw.X[i * 3 + 1], z = Rw.X[i * 3 + 2], ix = Math.floor(x / VC), iy = Math.floor(y / VC), iz = Math.floor(z / VC), fx = x / VC - ix, fy = y / VC - iy, fz = z / VC - iz;
    const ax = fx < m ? -1 : (fx > 1 - m ? 1 : 0), ay = fy < m ? -1 : (fy > 1 - m ? 1 : 0), az = fz < m ? -1 : (fz > 1 - m ? 1 : 0);
    let hit = false;
    for (let dx = 0; !hit && dx <= (ax ? 1 : 0); dx++) for (let dy = 0; !hit && dy <= (ay ? 1 : 0); dy++) for (let dz = 0; !hit && dz <= (az ? 1 : 0); dz++)
      if (gs.has(hashCell(ix + dx * ax, iy + dy * ay, iz + dz * az, 0x3fffffff))) hit = true;
    if (hit) near[qn++] = i;
  }
  let QX = Rw.X, QI = null;
  if (qn < Rw.n) { QX = new Float64Array(qn * 3); QI = near; for (let k = 0; k < qn; k++) { const i = near[k]; QX[k * 3] = Rw.X[i * 3]; QX[k * 3 + 1] = Rw.X[i * 3 + 1]; QX[k * 3 + 2] = Rw.X[i * 3 + 2]; } }
  const r = snap(GX, gn, GC, QX, qn, o);
  r.stats.none += Rw.n - qn;
  if (QI) for (let q = 0; q < r.k; q++) r.src[q] = QI[r.src[q]];
  for (const k of ['none', 'curv', 'far', 'dup', 'kept']) st[k] = r.stats[k];
  st.shift = Math.hypot(r.shift[0], r.shift[1], r.shift[2]);
  const rec = Buffer.allocUnsafe(rl);
  for (let q = 0; q < r.k; q++) {
    GB.copy(rec, 0, r.nb[q] * rl, r.nb[q] * rl + rl);
    const x = r.P[q * 3] + ox, y = r.P[q * 3 + 1] + oy, z = r.P[q * 3 + 2] + oz;
    rec.writeInt32LE(Math.round((x - H.ox) / H.sx), 0); rec.writeInt32LE(Math.round((y - H.oy) / H.sy), 4); rec.writeInt32LE(Math.round((z - H.oz) / H.sz), 8);
    rec.writeDoubleLE(Rw.T[r.src[q]], tOff);
    if (r.C) for (let a = 0; a < 3; a++) { const v = Math.round(r.C[q * 3 + a]); rec.writeUInt16LE(v < 0 ? 0 : (v > 65535 ? 65535 : v), rgb + a * 2); }
    put(rec, x, y, z);
  }
  return st;
}

/** Приёмник сырых точек по порядку времени: отрезок отдаётся в обработку, когда пришли точки через отрезок после него. */
function chunker(o, onChunk) {
  // начало отсчёта куска кратно ячейке cell: сетка занятых ячеек куска совпадает с общей картой globalOcc
  const CH = o.chunk, g = o.cell, raw = new Map(); let maxCh = -Infinity, pend = 0;
  const fire = (k) => { const a = raw.get(k); raw.delete(k); pend -= a.n; onChunk(k, a); };
  return {
    add(x, y, z, t) {
      const c = Math.floor(t / CH);
      let a = raw.get(c); if (!a) { a = { X: new Float64Array(3 << 16), T: new Float64Array(1 << 16), n: 0, ox: Math.round(x / g) * g, oy: Math.round(y / g) * g, oz: Math.round(z / g) * g }; raw.set(c, a); }
      if (a.n >= a.T.length) { const X2 = new Float64Array(a.X.length * 2); X2.set(a.X); a.X = X2; const T2 = new Float64Array(a.T.length * 2); T2.set(a.T); a.T = T2; }
      a.X[a.n * 3] = x - a.ox; a.X[a.n * 3 + 1] = y - a.oy; a.X[a.n * 3 + 2] = z - a.oz; a.T[a.n] = t; a.n++; pend++;
      if (c > maxCh) { maxCh = c; for (const k of [...raw.keys()].sort((u, v) => u - v)) if (k < c - 1) fire(k); }
      if (pend > (o.maxPending || 40e6)) fire(Math.min(...raw.keys()));
    },
    end() { for (const k of [...raw.keys()].sort((u, v) => u - v)) fire(k); }
  };
}

/** Писатель записей LAS в файл (буфер 2 МБ) с рамкой координат. */
function recWriter(fd, rl, pos0) {
  const OB = Buffer.allocUnsafe(rl * 65536); let fill = 0, pos = pos0, n = 0;
  const bb = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity];
  const flush = () => { if (fill) { fs.writeSync(fd, OB, 0, fill, pos); pos += fill; fill = 0; } };
  return {
    put(rec, x, y, z) {
      if (fill + rl > OB.length) flush();
      rec.copy(OB, fill, 0, rl); fill += rl; n++;
      if (x < bb[0]) bb[0] = x; if (y < bb[1]) bb[1] = y; if (z < bb[2]) bb[2] = z; if (x > bb[3]) bb[3] = x; if (y > bb[4]) bb[4] = y; if (z > bb[5]) bb[5] = z;
    },
    flush, get pos() { flush(); return pos; }, get n() { return n; }, bb
  };
}

/** Отрезок сырого лидара [a·chunk, (b+1)·chunk) из .xbin: прижатые точки — в файл out. Работает и в потоке пула. */
function runSegment(ctx, C, xfd, lo, a, b, out) {
  const XL = require('./xbin-lidar'), o = ctx.o, fd = fs.openSync(out, 'w');
  const st = { raw: 0, none: 0, curv: 0, far: 0, dup: 0, kept: 0, chunks: 0, shifts: [] };
  try {
    const W = recWriter(fd, ctx.H.rl, 0);
    const K = chunker(o, (c, Rw) => { const s = processChunk(ctx, c, Rw, W.put); st.chunks++; for (const k of ['raw', 'none', 'curv', 'far', 'dup', 'kept']) st[k] += s[k]; st.shifts.push(s.shift); });
    XL.walk(xfd, C, lo, Math.max(C.T0, a * o.chunk), Math.min(C.T1, (b + 1) * o.chunk - 1e-7), 1, (x, y, z, t) => K.add(x, y, z, t));
    K.end(); W.flush();
    return Object.assign(st, { w: W.pos, n: W.n, bb: W.bb });
  } finally { fs.closeSync(fd); }
}

/**
 * Общая для всей съёмки карта занятых ячеек cell (хеш-битовая, ~24 бита на точку опоры — запас на столько же новых точек, до 512 МБ): сначала — все точки опоры,
 * затем новые точки по порядку отрезков. На месте, которое сканер прошёл несколько раз, каждый проход добавляет точки
 * только в ячейки, пустые по всему облаку, — плотность ровная, облако не растёт с числом проходов. Совпадение хешей —
 * точка просто не добавляется. Порядок отрезков фиксирован, поэтому итог не зависит от числа потоков.
 */
function globalOcc(n, cell) {
  const bits = Math.max(20, Math.min(32, Math.ceil(Math.log2(Math.max(1, n) * 24)))), Wd = new Int32Array(2 ** (bits - 5)), sh = 32 - bits;
  const key = (x, y, z) => {
    let h = Math.imul(Math.floor(x / cell), 73856093) ^ Math.imul(Math.floor(y / cell), 19349663) ^ Math.imul(Math.floor(z / cell), 83492791);
    h = Math.imul(h ^ (h >>> 15), 0x2c1b3c6d); h ^= h >>> 12; h = Math.imul(h, 0x297a2d39); h ^= h >>> 15;
    return sh ? h >>> sh : h >>> 0;
  };
  return {
    bits,
    mark(x, y, z) { const k = key(x, y, z); Wd[k >>> 5] |= 1 << (k & 31); },
    take(x, y, z) { const k = key(x, y, z), w = k >>> 5, b = 1 << (k & 31); if (Wd[w] & b) return false; Wd[w] |= b; return true; }
  };
}

function pickThreads(o, jobs) {
  if (o.threads) return Math.max(1, Math.min(jobs, 32, Math.floor(o.threads)));
  const os = require('node:os'), cpu = typeof os.availableParallelism === 'function' ? os.availableParallelism() : os.cpus().length;
  const byMem = Math.floor((os.freemem() - (1024 << 20)) / (o.memPerThread || (900 << 20)));   // отрезок 10 с: ~3 млн сырых + опора ±3 отрезка
  return Math.max(1, Math.min(Math.max(1, cpu - 1), byMem, 16, jobs));
}

/**
 * densifyLas(guidePath, outPath, raw, opt, onProgress) — новый LAS: все точки guidePath + прижатые сырые точки.
 *   raw: { xbinPath, posesText, lidarOpt } — сырой лидар прямо из .xbin (xbin-lidar; отрезки по 60 с — на всех ядрах),
 *        или { lasPath } — облако сырого лидара LAS (по порядку файла, в одном потоке).
 *   В guidePath нужно время точек (форматы LAS 1, 3, 5–10): опора для сырой точки — точки того же отрезка времени (opt.chunk, с) ± margin.
 */
async function densifyLas(guidePath, outPath, raw, opt, onProgress) {
  const o = Object.assign({}, DEF, opt || {}), prog = typeof onProgress === 'function' ? onProgress : () => {};
  const t0 = Date.now(), gfd = fs.openSync(guidePath, 'r');
  let ofd = null, tmp = null, xfd = null; const workers = [];
  try {
    const H = R.readHeader(gfd);
    if (H.tOff === undefined) throw new Error('в облаке нет времени точек (нужен LAS формата 1, 3 или 6–8)');
    const rl = H.rl, tOff = H.tOff, CH = o.chunk;
    tmp = fs.mkdtempSync(path.join(o.tmpDir || path.dirname(path.resolve(outPath)), '.bimtwin-densify-'));
    // 1) копия опоры в выход + раскладка опоры по отрезкам времени во временные файлы
    ofd = fs.openSync(outPath, 'w+');
    { const hb = Buffer.alloc(H.off); fs.readSync(gfd, hb, 0, H.off, 0); fs.writeSync(ofd, hb, 0, H.off, 0); }
    let wpos = H.off; const bb = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity];
    const pend = new Map(); let pendBytes = 0, tMin = Infinity, tMax = -Infinity;
    const GO = o.globalOcc === false ? null : globalOcc(H.n, o.cell); let dupGlobal = 0;
    const flushPend = () => { for (const [c, arr] of pend) fs.appendFileSync(path.join(tmp, c + '.g'), Buffer.concat(arr)); pend.clear(); pendBytes = 0; };
    const per = 1 << 18, buf = Buffer.allocUnsafe(per * rl);
    const push = (c, a, b) => { let x = pend.get(c); if (!x) pend.set(c, x = []); x.push(Buffer.from(buf.subarray(a * rl, b * rl))); pendBytes += (b - a) * rl; };
    for (let i = 0; i < H.n; i += per) {
      const c = Math.min(per, H.n - i), bytes = c * rl; let got = 0;
      while (got < bytes) { const r = fs.readSync(gfd, buf, got, bytes - got, H.off + i * rl + got); if (!r) throw new Error('файл LAS обрезан'); got += r; }
      fs.writeSync(ofd, buf, 0, bytes, wpos); wpos += bytes;
      let s = 0, cur = null;
      for (let q = 0; q < c; q++) {
        const p = q * rl, t = buf.readDoubleLE(p + tOff), ch = Math.floor(t / CH);
        if (t < tMin) tMin = t; if (t > tMax) tMax = t;
        const x = buf.readInt32LE(p) * H.sx + H.ox, y = buf.readInt32LE(p + 4) * H.sy + H.oy, z = buf.readInt32LE(p + 8) * H.sz + H.oz;
        if (x < bb[0]) bb[0] = x; if (y < bb[1]) bb[1] = y; if (z < bb[2]) bb[2] = z; if (x > bb[3]) bb[3] = x; if (y > bb[4]) bb[4] = y; if (z > bb[5]) bb[5] = z;
        if (GO) GO.mark(x, y, z);
        if (ch !== cur) { if (cur !== null) push(cur, s, q); cur = ch; s = q; }
      }
      if (cur !== null) push(cur, s, c);
      if (pendBytes > (96 << 20)) flushPend();
      prog(0.2 * (i + c) / H.n, 'Уплотнение: раскладка облака по времени…');
    }
    flushPend();
    const HH = { rl, rgb: H.rgb, tOff, sx: H.sx, sy: H.sy, sz: H.sz, ox: H.ox, oy: H.oy, oz: H.oz };
    const ctx = { H: HH, tmp, o };
    const st = { raw: 0, none: 0, curv: 0, far: 0, dup: 0, kept: 0, chunks: 0 }, shifts = [];
    const addSt = (s) => { for (const k of ['raw', 'none', 'curv', 'far', 'dup', 'kept', 'chunks']) st[k] += s[k] || 0; for (const v of s.shifts || []) shifts.push(v); if (s.bb) for (let a = 0; a < 3; a++) { if (s.bb[a] < bb[a]) bb[a] = s.bb[a]; if (s.bb[a + 3] > bb[a + 3]) bb[a + 3] = s.bb[a + 3]; } };
    let added = 0, threads = 1;
    if (raw && raw.xbinPath) {
      const XL = require('./xbin-lidar');
      const lo = Object.assign({}, XL.DEF, raw.lidarOpt || {}, { t0: tMin - 0.5, t1: tMax + 0.5 });
      lo.index = lo.index || XL.scan(raw.xbinPath, (f) => prog(0.2 + 0.05 * f, 'Уплотнение: оглавление .xbin…'));
      const C = XL.prepare(raw.xbinPath, raw.posesText, lo, () => {});
      // отрезки по segChunks отрезков времени
      const c0 = Math.floor(C.T0 / CH), c1 = Math.floor(C.T1 / CH), SEG = Math.max(1, o.segChunks || 6), jobs = [];
      for (let a = c0; a <= c1; a += SEG) jobs.push([a, Math.min(c1, a + SEG - 1)]);
      const segBytes = jobs.map(([a, b]) => C.recs.reduce((s, r) => s + (r.t >= a * CH - 1.5 && r.t < (b + 1) * CH ? r.len : 0), 0)), total = segBytes.reduce((s, v) => s + v, 0) || 1;
      threads = pickThreads(o, jobs.length);
      let done = 0;
      const take = (j, r) => {
        const f = path.join(tmp, 's' + j + '.out');
        let kept = 0;
        if (r.w) {
          const fd = fs.openSync(f, 'r'), B = Buffer.allocUnsafe(Math.min(r.w, rl * 262144));
          try {
            for (let p = 0; p < r.w;) {
              const k = fs.readSync(fd, B, 0, Math.min(B.length, r.w - p), p); if (!k || k % rl) throw new Error('уплотнение: неполный отрезок ' + j);
              let w = 0;
              for (let q = 0; q < k; q += rl) {
                const x = B.readInt32LE(q) * H.sx + H.ox, y = B.readInt32LE(q + 4) * H.sy + H.oy, z = B.readInt32LE(q + 8) * H.sz + H.oz;
                if (GO && !GO.take(x, y, z)) { dupGlobal++; continue; }
                if (w !== q) B.copy(B, w, q, q + rl); w += rl; kept++;
                if (x < bb[0]) bb[0] = x; if (y < bb[1]) bb[1] = y; if (z < bb[2]) bb[2] = z; if (x > bb[3]) bb[3] = x; if (y > bb[4]) bb[4] = y; if (z > bb[5]) bb[5] = z;
              }
              if (w) { fs.writeSync(ofd, B, 0, w, wpos); wpos += w; }
              p += k;
            }
          } finally { fs.closeSync(fd); }
        }
        try { fs.unlinkSync(f); } catch (_) {}
        added += kept; r.bb = null; addSt(r); done += segBytes[j];
        prog(0.25 + 0.74 * done / total, 'Уплотнение: точки сырого лидара…');
      };
      if (threads <= 1) {
        xfd = fs.openSync(raw.xbinPath, 'r');
        for (let j = 0; j < jobs.length; j++) take(j, runSegment(ctx, C, xfd, lo, jobs[j][0], jobs[j][1], path.join(tmp, 's' + j + '.out')));
      } else {
        const { Worker } = require('node:worker_threads');
        const data = { __densify: true, ctx, xbinPath: raw.xbinPath, posesText: raw.posesText, lo };
        await new Promise((resolve, reject) => {
          const res = new Map(); let next = 0, write = 0, failed = false;
          const fail = (e) => { if (failed) return; failed = true; reject(e instanceof Error ? e : new Error(String(e))); };
          const flush = () => { try { while (write < jobs.length && res.has(write)) { const r = res.get(write); res.delete(write); take(write, r); write++; } } catch (e) { fail(e); return; } if (write >= jobs.length && !failed) resolve(); };
          const give = (w) => { if (failed) return; if (next < jobs.length) { const j = next++; w.busy = true; w.postMessage({ type: 'seg', j, a: jobs[j][0], b: jobs[j][1] }); } else w.busy = false; };
          for (let i = 0; i < threads; i++) {
            const w = new Worker(o._workerPath || __filename, { workerData: data }); workers.push(w);
            w.on('message', (m) => {
              if (!m) return;
              if (m.type === 'ready') give(w);
              else if (m.type === 'done') { w.busy = false; res.set(m.j, m.r); give(w); flush(); }
              else if (m.type === 'error') fail(new Error('уплотнение, отрезок' + (m.j !== undefined ? ' ' + m.j : '') + ': ' + m.error));
            });
            w.on('error', fail);
            w.on('exit', (code) => { if (!failed && write < jobs.length && (code !== 0 || w.busy)) fail(new Error('поток уплотнения завершился с кодом ' + code)); });
          }
        });
      }
    } else if (raw && raw.lasPath) {
      const rfd = fs.openSync(raw.lasPath, 'r');
      try {
        const RH = R.readHeader(rfd); if (RH.tOff === undefined) throw new Error('в облаке сырого лидара нет времени точек');
        const W = recWriter(ofd, rl, wpos);
        // ячейка — по записанным (округлённым до шага LAS) координатам, как при чтении готового облака
        const put = (rec, x, y, z) => { if (GO && !GO.take(rec.readInt32LE(0) * H.sx + H.ox, rec.readInt32LE(4) * H.sy + H.oy, rec.readInt32LE(8) * H.sz + H.oz)) { dupGlobal++; return; } W.put(rec, x, y, z); };
        const K = chunker(o, (c, Rw) => { const s = processChunk(ctx, c, Rw, put); s.chunks = 1; s.shifts = [s.shift]; s.bb = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity]; addSt(s); });
        const rb = Buffer.allocUnsafe(per * RH.rl);
        for (let i = 0; i < RH.n; i += per) {
          const c = Math.min(per, RH.n - i), bytes = c * RH.rl; let got = 0;
          while (got < bytes) { const r = fs.readSync(rfd, rb, got, bytes - got, RH.off + i * RH.rl + got); if (!r) throw new Error('файл LAS обрезан'); got += r; }
          for (let q = 0, p = 0; q < c; q++, p += RH.rl) { const t = rb.readDoubleLE(p + RH.tOff); if (t < tMin - CH || t > tMax + CH) continue; K.add(rb.readInt32LE(p) * RH.sx + RH.ox, rb.readInt32LE(p + 4) * RH.sy + RH.oy, rb.readInt32LE(p + 8) * RH.sz + RH.oz, t); }
          prog(0.25 + 0.74 * (i + c) / RH.n, 'Уплотнение: точки сырого лидара…');
        }
        K.end(); wpos = W.pos; added = W.n;
        for (let a = 0; a < 3; a++) { if (W.bb[a] < bb[a]) bb[a] = W.bb[a]; if (W.bb[a + 3] > bb[a + 3]) bb[a + 3] = W.bb[a + 3]; }
      } finally { fs.closeSync(rfd); }
    } else throw new Error('нет источника сырых точек');
    shifts.sort((a, b) => a - b);
    R.finishLas(ofd, H, H.n + added, bb, wpos); fs.closeSync(ofd); ofd = null;
    prog(1, 'Уплотнение: готово');
    return Object.assign(st, { dupGlobal, kept: st.kept - dupGlobal, guide: H.n, added, points: H.n + added, shiftMedianMm: shifts.length ? Math.round(shifts[shifts.length >> 1] * 10000) / 10 : 0, threads, ms: Date.now() - t0 });
  } catch (e) {
    if (ofd !== null) { try { fs.closeSync(ofd); } catch (_) {} ofd = null; try { fs.rmSync(outPath, { force: true }); } catch (_) {} }
    throw e;
  } finally {
    for (const w of workers) { try { await w.terminate(); } catch (_) {} }
    if (ofd !== null) { try { fs.closeSync(ofd); } catch (_) {} }
    if (xfd !== null) { try { fs.closeSync(xfd); } catch (_) {} }
    fs.closeSync(gfd);
    if (tmp) { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) {} }
  }
}

module.exports = { snap, densifyLas, processChunk, runSegment, minEig, DEF };

const wt = require('node:worker_threads');
if (!wt.isMainThread && wt.workerData && wt.workerData.__densify) {   // поток пула уплотнения
  const d = wt.workerData; let C = null, xfd = null;
  try { C = require('./xbin-lidar').prepare(d.xbinPath, d.posesText, d.lo, () => {}); xfd = fs.openSync(d.xbinPath, 'r'); }
  catch (e) { wt.parentPort.postMessage({ type: 'error', error: String((e && e.message) || e) }); }
  if (C) {
    wt.parentPort.on('message', (m) => {
      if (!m || m.type !== 'seg') return;
      try { const r = runSegment(d.ctx, C, xfd, d.lo, m.a, m.b, path.join(d.ctx.tmp, 's' + m.j + '.out')); wt.parentPort.postMessage({ type: 'done', j: m.j, r }); }
      catch (e) { wt.parentPort.postMessage({ type: 'error', j: m.j, error: String((e && e.message) || e) }); }
    });
    wt.parentPort.postMessage({ type: 'ready' });
  }
}
