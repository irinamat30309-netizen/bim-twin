'use strict';
/*
 * dynamic-clean-core.js — удаление движущихся объектов (люди, машины, «следы») по траектории сканера.
 * Идея (как в DUFOMap / OctoMap-removal): если сканер в другое время «видел сквозь» место, где были точки,
 * значит, в момент съёмки там стоял движущийся объект. Нужны время точки (GPS time LAS) и траектория (poses.csv Lixel).
 *
 * Проход 1: воксели вокруг маршрута — число попаданий H и интервал времени, когда воксель был занят [tMin, tMax].
 * Проход 2: лучи сканер→точка (каждая k-я точка). Воксель, через который луч прошёл в момент, когда он НЕ был занят,
 *           получает «просвет» F. Касательные лучи у стен и пола в то же время сами дают попадания и не считаются.
 * Решение: воксель движущийся, если F ≥ fMin и F·k ≥ ratio·H. Точки в таких вокселях, а также точки ближе nearRange
 *           к сканеру (сам оператор) помечаются на удаление. Память: только занятые блоки 4×4×4 вокселя.
 */
const fs = require('node:fs');

function parsePoses(text) {
  const T = [], X = [], Y = [], Z = [];
  for (const line of String(text).split(/\r?\n/)) {
    const s = line.trim(); if (!s || /^[a-z#]/i.test(s)) continue;
    const a = s.split(/[,;\s]+/).map(Number);
    if (a.length < 4 || !a.slice(0, 4).every(Number.isFinite)) continue;
    T.push(a[0]); X.push(a[1]); Y.push(a[2]); Z.push(a[3]);
  }
  const o = Array.from(T.keys()).sort((i, j) => T[i] - T[j]);
  return { n: o.length, t: Float64Array.from(o, i => T[i]), x: Float64Array.from(o, i => X[i]), y: Float64Array.from(o, i => Y[i]), z: Float64Array.from(o, i => Z[i]) };
}

function makePoseAt(P) {
  const t = P.t, n = P.n; let last = 0;
  return function poseAt(tt, out) {
    let i = last;
    if (!(t[i] <= tt && (i + 1 >= n || tt < t[i + 1]))) {
      let lo = 0, hi = n - 1;
      if (tt <= t[0]) { i = 0; } else if (tt >= t[n - 1]) { i = n - 1; } else { while (hi - lo > 1) { const m = (lo + hi) >> 1; if (t[m] <= tt) lo = m; else hi = m; } i = lo; }
      last = i;
    }
    if (i >= n - 1 || tt <= t[0]) { const k = tt <= t[0] ? 0 : n - 1; out[0] = P.x[k]; out[1] = P.y[k]; out[2] = P.z[k]; return Math.abs(tt - t[k]); }
    const w = (tt - t[i]) / (t[i + 1] - t[i]);
    out[0] = P.x[i] + (P.x[i + 1] - P.x[i]) * w; out[1] = P.y[i] + (P.y[i + 1] - P.y[i]) * w; out[2] = P.z[i] + (P.z[i + 1] - P.z[i]) * w;
    return 0;
  };
}

function readLasHeader(fd) {
  const h = Buffer.alloc(375); fs.readSync(fd, h, 0, 375, 0);
  if (h.toString('latin1', 0, 4) !== 'LASF') throw new Error('не LAS');
  const minor = h[25], off = h.readUInt32LE(96), fmt = h[104] & 0x3f, rl = h.readUInt16LE(105);
  let n = h.readUInt32LE(107); if (minor >= 4) { const n2 = Number(h.readBigUInt64LE(247)); if (n2 > 0) n = n2; }
  const TOFF = { 1: 20, 3: 20, 4: 20, 5: 20, 6: 22, 7: 22, 8: 22, 9: 22, 10: 22 };
  if (TOFF[fmt] === undefined) throw new Error('в LAS нет времени точек (формат ' + fmt + ')');
  return { off, fmt, rl, n, tOff: TOFF[fmt], sx: h.readDoubleLE(131), sy: h.readDoubleLE(139), sz: h.readDoubleLE(147), ox: h.readDoubleLE(155), oy: h.readDoubleLE(163), oz: h.readDoubleLE(171) };
}

// Чтение LAS кусками: cb(buf, firstIndex, count)
function scanLas(fd, H, cb, chunk) {
  const per = chunk || 1 << 20, buf = Buffer.allocUnsafe(per * H.rl);
  for (let i = 0; i < H.n; i += per) {
    const c = Math.min(per, H.n - i), bytes = c * H.rl; let got = 0;
    while (got < bytes) { const r = fs.readSync(fd, buf, got, bytes - got, H.off + i * H.rl + got); if (!r) throw new Error('короткое чтение LAS'); got += r; }
    cb(buf, i, c);
  }
}

// Наименьшее собственное значение (доля от следа) и его вектор для симметричной 3×3 (Якоби): плоскостность и нормаль
function smallestEig(a00, a01, a02, a11, a12, a22, out) {
  const A = [[a00, a01, a02], [a01, a11, a12], [a02, a12, a22]], V = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
  for (let sw = 0; sw < 8; sw++) {
    const off = A[0][1] * A[0][1] + A[0][2] * A[0][2] + A[1][2] * A[1][2]; if (off < 1e-18) break;
    for (let p = 0; p < 2; p++) for (let q = p + 1; q < 3; q++) {
      if (Math.abs(A[p][q]) < 1e-15) continue;
      const th = (A[q][q] - A[p][p]) / (2 * A[p][q]), t = Math.sign(th || 1) / (Math.abs(th) + Math.sqrt(th * th + 1)), c = 1 / Math.sqrt(t * t + 1), s = t * c;
      for (let r = 0; r < 3; r++) { const arp = A[r][p], arq = A[r][q]; A[r][p] = c * arp - s * arq; A[r][q] = s * arp + c * arq; }
      for (let r = 0; r < 3; r++) { const apr = A[p][r], aqr = A[q][r]; A[p][r] = c * apr - s * aqr; A[q][r] = s * apr + c * aqr; }
      for (let r = 0; r < 3; r++) { const vrp = V[r][p], vrq = V[r][q]; V[r][p] = c * vrp - s * vrq; V[r][q] = s * vrp + c * vrq; }
    }
  }
  let i = 0; if (A[1][1] < A[i][i]) i = 1; if (A[2][2] < A[i][i]) i = 2;
  const tr = A[0][0] + A[1][1] + A[2][2];
  out[0] = V[0][i]; out[1] = V[1][i]; out[2] = V[2][i];
  return tr > 1e-12 ? Math.max(0, A[i][i]) / tr : 1;
}

function run(lasPath, poses, opt, onProgress) {
  opt = Object.assign({ voxel: 0.1, radius: 35, zBelow: 3, zAbove: 3.5, rayStep: 4, marginMin: 0.3, marginRel: 0.06, startSkip: 0.5,
    bins: 128, minBinSec: 4, fMin: 3, ratio: 0.6, minHits: 2, nearRange: 0, farRange: 0, maxRay: 60, vote: 2, minCluster: 6, strongRatio: 3, dilate: 1, hitRadius: 0.35, grazing: 0.2, planarity: 0.06, attach: 0, attachMin: 30, maxSeen: 50 }, opt || {});
  const prog = typeof onProgress === 'function' ? onProgress : () => {};
  const P = typeof poses === 'string' ? parsePoses(poses) : poses;
  if (!P || P.n < 2) throw new Error('траектория пуста');
  const poseAt = makePoseAt(P);
  const fd = fs.openSync(lasPath, 'r');
  try {
    const H = readLasHeader(fd), N = H.n, rl = H.rl, tO = H.tOff;
    const v = opt.voxel, iv = 1 / v;
    let mnx = Infinity, mny = Infinity, mnz = Infinity, mxx = -Infinity, mxy = -Infinity, mxz = -Infinity;
    for (let i = 0; i < P.n; i++) { mnx = Math.min(mnx, P.x[i]); mxx = Math.max(mxx, P.x[i]); mny = Math.min(mny, P.y[i]); mxy = Math.max(mxy, P.y[i]); mnz = Math.min(mnz, P.z[i]); mxz = Math.max(mxz, P.z[i]); }
    const gx = mnx - opt.radius, gy = mny - opt.radius, gz = mnz - opt.zBelow;
    const nx = Math.ceil((mxx - mnx + 2 * opt.radius) * iv), ny = Math.ceil((mxy - mny + 2 * opt.radius) * iv), nz = Math.ceil((mxz - mnz + opt.zBelow + opt.zAbove) * iv);
    const bx = (nx + 3) >> 2, by = (ny + 3) >> 2, bz = (nz + 3) >> 2;
    const blk = new Int32Array(bx * by * bz).fill(-1);
    let cap = 1 << 16, nb = 0;
    const W = Math.max(1, Math.ceil(Math.min(512, opt.bins) / 32));
    let Hc = new Uint16Array(cap * 64), Bm = new Uint32Array(cap * 64 * W), Fc = new Uint16Array(cap * 64), Cs = new Float32Array(cap * 64 * 3);
    const grow = () => { const nc = cap * 2; const a = new Uint16Array(nc * 64); a.set(Hc); Hc = a; const b = new Uint32Array(nc * 64 * W); b.set(Bm); Bm = b; const d = new Uint16Array(nc * 64); d.set(Fc); Fc = d; const e = new Float32Array(nc * 64 * 3); e.set(Cs); Cs = e; cap = nc; };
    const t0 = P.t[0] - 1, dur = P.t[P.n - 1] - t0 + 2, binSec = Math.max(opt.minBinSec, dur / (W * 32)), NB = W * 32;
    const binOf = (tt) => { const b = Math.floor((tt - t0) / binSec); return b < 0 ? 0 : (b >= NB ? NB - 1 : b); };
    const vox = (ix, iy, iz, alloc) => {
      const b = ((iz >> 2) * by + (iy >> 2)) * bx + (ix >> 2); let id = blk[b];
      if (id < 0) { if (!alloc) return -1; if (nb >= cap) grow(); id = blk[b] = nb++; }
      return id * 64 + (((iz & 3) << 4) | ((iy & 3) << 2) | (ix & 3));
    };
    const tStart = Date.now();
    // отладка/настройка: сохранённое состояние после лучей (Hc, Fc) — решение пересчитывается без чтения файла
    const LS = opt.loadState ? JSON.parse(fs.readFileSync(opt.loadState + '.json', 'utf8')) : null;
    if (LS) {
      const bin = fs.readFileSync(opt.loadState + '.bin'); nb = LS.nb; cap = nb;
      const ab = bin.buffer.slice(bin.byteOffset, bin.byteOffset + bin.byteLength);
      blk.set(new Int32Array(ab, 0, blk.length)); Hc = new Uint16Array(ab, blk.length * 4, nb * 64); Fc = new Uint16Array(ab, blk.length * 4 + nb * 128, nb * 64);
      LS.Oc = new Uint8Array(ab, blk.length * 4 + nb * 256, nb * 64);
    }
    // ---- проход 1
    if (!LS) scanLas(fd, H, (buf, first, c) => {
      for (let j = 0, o = 0; j < c; j++, o += rl) {
        const x = buf.readInt32LE(o) * H.sx + H.ox, y = buf.readInt32LE(o + 4) * H.sy + H.oy, z = buf.readInt32LE(o + 8) * H.sz + H.oz;
        const ix = Math.floor((x - gx) * iv), iy = Math.floor((y - gy) * iv), iz = Math.floor((z - gz) * iv);
        if (ix < 0 || iy < 0 || iz < 0 || ix >= nx || iy >= ny || iz >= nz) continue;
        const k = vox(ix, iy, iz, true), bn = binOf(buf.readDoubleLE(o + tO));
        if (Hc[k] < 65535) { Hc[k]++; Cs[k * 3] += (x - gx) * iv - ix; Cs[k * 3 + 1] += (y - gy) * iv - iy; Cs[k * 3 + 2] += (z - gz) * iv - iz; } Bm[k * W + (bn >> 5)] |= (1 << (bn & 31));
      }
      prog(0.33 * (first + c) / N, 'занятость');
    });
    // Допуск на неточность совмещения проходов (realtime-карта сканера: одна стена из разных проходов сдвинута на сантиметры):
    // занятость по времени «размазывается» на соседние воксели. Луч считается просветом, только если в это время
    // не было попаданий ни в сам воксель, ни рядом с ним.
    const blkPos = new Int32Array(nb * 3);
    for (let b = 0; b < blk.length; b++) { const id = blk[b]; if (id < 0) continue; const X = b % bx, Y = ((b / bx) | 0) % by, Z = (b / (bx * by)) | 0; blkPos[id * 3] = X << 2; blkPos[id * 3 + 1] = Y << 2; blkPos[id * 3 + 2] = Z << 2; }
    const kxyz = (k, out) => { const b = (k >> 6), l = k & 63; out[0] = blkPos[b * 3] + (l & 3); out[1] = blkPos[b * 3 + 1] + ((l >> 2) & 3); out[2] = blkPos[b * 3 + 2] + (l >> 4); };
    const c3 = new Int32Array(3);
    // сколько корзин времени воксель был занят (до размывания): прохожий виден секунды, стоящий объект — минуты
    let Oc = LS ? LS.Oc : new Uint8Array(nb * 64);
    if (!LS) for (let k = 0; k < nb * 64; k++) { if (!Hc[k]) continue; let c = 0; for (let w = 0; w < W; w++) { let x = Bm[k * W + w]; x -= (x >>> 1) & 0x55555555; x = (x & 0x33333333) + ((x >>> 2) & 0x33333333); c += (((x + (x >>> 4)) & 0x0f0f0f0f) * 0x01010101) >>> 24; } Oc[k] = c > 255 ? 255 : c; }
    if (opt.dilate > 0 && !LS) {
      const R = opt.dilate | 0, Bd = new Uint32Array(nb * 64 * W);
      for (let k = 0; k < nb * 64; k++) {
        if (!Hc[k]) continue; kxyz(k, c3);
        for (let dz = -R; dz <= R; dz++) for (let dy = -R; dy <= R; dy++) for (let dx = -R; dx <= R; dx++) {
          const X = c3[0] + dx, Y = c3[1] + dy, Z = c3[2] + dz; if (X < 0 || Y < 0 || Z < 0 || X >= nx || Y >= ny || Z >= nz) continue;
          const q = vox(X, Y, Z, false); if (q < 0 || !Hc[q]) continue;
          for (let w = 0; w < W; w++) Bd[k * W + w] |= Bm[q * W + w];
        }
      }
      Bm = Bd;
    }
    for (let k = 0; k < nb * 64; k++) { const h = Hc[k]; if (!h) continue; kxyz(k, c3); Cs[k * 3] = c3[0] + Cs[k * 3] / h; Cs[k * 3 + 1] = c3[1] + Cs[k * 3 + 1] / h; Cs[k * 3 + 2] = c3[2] + Cs[k * 3 + 2] / h; }
    const hr2 = opt.hitRadius * opt.hitRadius;
    // Нормаль поверхности вокселя (по центроидам занятых соседей 3×3×3): лучи, идущие почти вдоль плоской поверхности
    // (крыша контейнера, пол, стена под острым углом), просветом не считаются — из-за шума дальномера они «проходят» сквозь неё.
    const Nq = opt.grazing > 0 && !LS ? new Int8Array(nb * 64 * 3) : null;
    if (Nq) {
      const ev = new Float64Array(3);
      for (let k = 0; k < nb * 64; k++) {
        if (!Hc[k]) continue; kxyz(k, c3);
        let m = 0, sx = 0, sy = 0, sz = 0, xx = 0, xy = 0, xz = 0, yy = 0, yz = 0, zz = 0;
        for (let dz = -1; dz <= 1; dz++) for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
          const X = c3[0] + dx, Y = c3[1] + dy, Z = c3[2] + dz; if (X < 0 || Y < 0 || Z < 0 || X >= nx || Y >= ny || Z >= nz) continue;
          const q = vox(X, Y, Z, false); if (q < 0 || !Hc[q]) continue;
          const a = Cs[q * 3], b = Cs[q * 3 + 1], c = Cs[q * 3 + 2]; m++; sx += a; sy += b; sz += c; xx += a * a; xy += a * b; xz += a * c; yy += b * b; yz += b * c; zz += c * c;
        }
        if (m < 5) continue;
        sx /= m; sy /= m; sz /= m;
        const n = smallestEig(xx / m - sx * sx, xy / m - sx * sy, xz / m - sx * sz, yy / m - sy * sy, yz / m - sy * sz, zz / m - sz * sz, ev);
        if (n > opt.planarity) continue;
        Nq[k * 3] = Math.round(ev[0] * 127); Nq[k * 3 + 1] = Math.round(ev[1] * 127); Nq[k * 3 + 2] = Math.round(ev[2] * 127);
      }
    }
    const gz2 = opt.grazing * 127;
    const t1 = Date.now();
    // ---- проход 2: лучи
    const sp = new Float64Array(3), step = Math.max(1, opt.rayStep | 0);
    let rays = 0, steps = 0;
    if (!LS) scanLas(fd, H, (buf, first, c) => {
      for (let j = (step - (first % step)) % step, o = j * rl; j < c; j += step, o += step * rl) {
        const tt = buf.readDoubleLE(o + tO);
        if (poseAt(tt, sp) > 1) continue;
        const x = buf.readInt32LE(o) * H.sx + H.ox, y = buf.readInt32LE(o + 4) * H.sy + H.oy, z = buf.readInt32LE(o + 8) * H.sz + H.oz;
        let dx = x - sp[0], dy = y - sp[1], dz = z - sp[2]; const L = Math.sqrt(dx * dx + dy * dy + dz * dz);
        if (L < opt.startSkip + opt.marginMin + v) continue;
        const Le = Math.min(L - Math.max(opt.marginMin, opt.marginRel * L), opt.maxRay); if (Le <= opt.startSkip) continue;
        dx /= L; dy /= L; dz /= L;
        // отрезок в координатах вокселей
        let a0 = opt.startSkip * iv, a1 = Le * iv;
        const ux = (sp[0] - gx) * iv, uy = (sp[1] - gy) * iv, uz = (sp[2] - gz) * iv;
        // отсечение по сетке (slab)
        const clip = (u, d, n) => { if (Math.abs(d) < 1e-12) return (u >= 0 && u < n); let ta = (0 - u) / d, tb = (n - 1e-6 - u) / d; if (ta > tb) { const q = ta; ta = tb; tb = q; } if (ta > a0) a0 = ta; if (tb < a1) a1 = tb; return a0 < a1; };
        if (!clip(ux, dx, nx) || !clip(uy, dy, ny) || !clip(uz, dz, nz)) continue;
        rays++;
        let px = ux + dx * a0, py = uy + dy * a0, pz = uz + dz * a0;
        let ix = Math.floor(px), iy = Math.floor(py), iz = Math.floor(pz);
        const sx = dx > 0 ? 1 : -1, sy = dy > 0 ? 1 : -1, sz = dz > 0 ? 1 : -1;
        const tdx = Math.abs(1 / dx), tdy = Math.abs(1 / dy), tdz = Math.abs(1 / dz);
        let tmx = dx > 0 ? (ix + 1 - px) * tdx : (px - ix) * tdx, tmy = dy > 0 ? (iy + 1 - py) * tdy : (py - iy) * tdy, tmz = dz > 0 ? (iz + 1 - pz) * tdz : (pz - iz) * tdz;
        const len = a1 - a0, bn = binOf(tt), bw = bn >> 5, bb = 1 << (bn & 31);
        let cur = 0;
        while (cur <= len) {
          if (ix >= 0 && iy >= 0 && iz >= 0 && ix < nx && iy < ny && iz < nz) {
            const b = blk[((iz >> 2) * by + (iy >> 2)) * bx + (ix >> 2)];
            if (b >= 0) {
              const k = b * 64 + (((iz & 3) << 4) | ((iy & 3) << 2) | (ix & 3));
              if (Hc[k] && !(Bm[k * W + bw] & bb) && Fc[k] < 65535) {
                // луч должен пройти рядом с самими точками вокселя (центроид), а не по краю ячейки — касательные лучи над крышей/полом не считаются
                const qx = Cs[k * 3] - ux, qy = Cs[k * 3 + 1] - uy, qz = Cs[k * 3 + 2] - uz, pr = qx * dx + qy * dy + qz * dz;
                if (qx * qx + qy * qy + qz * qz - pr * pr <= hr2 && (!Nq || Math.abs(Nq[k * 3] * dx + Nq[k * 3 + 1] * dy + Nq[k * 3 + 2] * dz) >= gz2 || (Nq[k * 3] | Nq[k * 3 + 1] | Nq[k * 3 + 2]) === 0)) Fc[k]++;
              }
            }
          }
          steps++;
          if (tmx < tmy) { if (tmx < tmz) { cur = tmx; tmx += tdx; ix += sx; } else { cur = tmz; tmz += tdz; iz += sz; } }
          else { if (tmy < tmz) { cur = tmy; tmy += tdy; iy += sy; } else { cur = tmz; tmz += tdz; iz += sz; } }
        }
      }
      prog(0.33 + 0.5 * (first + c) / N, 'лучи');
    });
    const t2 = Date.now();
    if (opt.saveState && !LS) {
      fs.writeFileSync(opt.saveState + '.json', JSON.stringify({ nb }));
      const fdo = fs.openSync(opt.saveState + '.bin', 'w');
      for (const a of [blk, Hc.subarray(0, nb * 64), Fc.subarray(0, nb * 64), Oc]) fs.writeSync(fdo, Buffer.from(a.buffer, a.byteOffset, a.byteLength));
      fs.closeSync(fdo);
    }
    // ---- решение по вокселям
    const NV = nb * 64, dyn = new Uint8Array(NV); let dynVox = 0, occVox = 0;
    for (let k = 0; k < NV; k++) { if (!Hc[k]) continue; occVox++; if (Hc[k] >= opt.minHits && Fc[k] >= opt.fMin && Fc[k] * step >= opt.ratio * Hc[k]) { dyn[k] = Fc[k] * step >= opt.strongRatio * Hc[k] ? 2 : 1; dynVox++; } }
    // координаты вокселя по индексу k: блок → (bx,by,bz)
    // голосование соседей: слабый «движущийся» воксель, окружённый неподвижными занятыми, остаётся (края поддонов, листва, решётки)
    for (let it = 0; it < opt.vote; it++) {
      const drop = [];
      for (let k = 0; k < NV; k++) {
        if (dyn[k] !== 1) continue; kxyz(k, c3); let st = 0, dn = 0;
        for (let dz = -1; dz <= 1; dz++) for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
          if (!dx && !dy && !dz) continue; const X = c3[0] + dx, Y = c3[1] + dy, Z = c3[2] + dz;
          if (X < 0 || Y < 0 || Z < 0 || X >= nx || Y >= ny || Z >= nz) continue; const q = vox(X, Y, Z, false); if (q < 0 || !Hc[q]) continue;
          if (dyn[q]) dn++; else st++;
        }
        if (st > dn) drop.push(k);
      }
      for (const k of drop) { dyn[k] = 0; dynVox--; }
      if (!drop.length) break;
    }
    // кластеры движущихся вокселей (26-связность): мелкие одиночные пятна без сильного признака не удаляем
    const clusters = opt.dumpClusters ? [] : null;
    if (opt.minCluster > 1) {
      const seen = new Uint8Array(NV), stack = [], comp = [];
      for (let k = 0; k < NV; k++) {
        if (!dyn[k] || seen[k]) continue; stack.length = 0; comp.length = 0; stack.push(k); seen[k] = 1; let strong = 0;
        while (stack.length) { const a = stack.pop(); comp.push(a); if (dyn[a] === 2) strong++; kxyz(a, c3); const ax = c3[0], ay = c3[1], az = c3[2];
          for (let dz = -1; dz <= 1; dz++) for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) { const X = ax + dx, Y = ay + dy, Z = az + dz;
            if (X < 0 || Y < 0 || Z < 0 || X >= nx || Y >= ny || Z >= nz) continue; const q = vox(X, Y, Z, false); if (q >= 0 && dyn[q] && !seen[q]) { seen[q] = 1; stack.push(q); } } }
        if (comp.length < opt.minCluster && strong * 2 < comp.length) { for (const a of comp) { dyn[a] = 0; dynVox--; } continue; }
        // «Приросший» к неподвижному кластер — часть стоящего объекта (экскаватор повернул стрелу, кузов, край крыши): занятые неподвижные
        // воксели вокруг него (кроме опоры снизу) сравниваются с его размером; прохожие и их следы окружены пустотой.
        let occSum = 0; for (const a of comp) occSum += Oc[a];
        const occMean = occSum / comp.length;
        // долго стоявший объект, который сдвинулся (экскаватор повернул стрелу, машина уехала после долгой стоянки), не удаляем — как Lixel
        // maxSeen — в секундах: сколько времени в среднем были заняты воксели кластера (по корзинам времени binSec)
        if (opt.maxSeen > 0 && occMean * binSec > opt.maxSeen) { for (const a of comp) { dyn[a] = 0; dynVox--; } if (clusters && comp.length >= 20) { kxyz(comp[0], c3); clusters.push([comp.length, strong, -1, +occMean.toFixed(2), c3[0], c3[1], c3[2]]); } continue; }
        if (opt.attach > 0 || clusters) {
          let adj = 0, zmin = Infinity; const touched = [];
          for (const a of comp) { kxyz(a, c3); if (c3[2] < zmin) zmin = c3[2]; }
          for (const a of comp) { kxyz(a, c3); const ax = c3[0], ay = c3[1], az = c3[2];
            for (let dz = -1; dz <= 1; dz++) for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) { const X = ax + dx, Y = ay + dy, Z = az + dz;
              if (Z <= zmin || X < 0 || Y < 0 || Z < 0 || X >= nx || Y >= ny || Z >= nz) continue; const q = vox(X, Y, Z, false); if (q < 0 || !Hc[q] || dyn[q] || seen[q] === 2) continue; seen[q] = 2; touched.push(q); adj++; } }
          for (const q of touched) seen[q] = 0;
          if (clusters && comp.length >= 20) { let x0 = 1e9, y0 = 1e9, x1 = -1e9, y1 = -1e9; for (const a of comp) { kxyz(a, c3); if (c3[0] < x0) x0 = c3[0]; if (c3[0] > x1) x1 = c3[0]; if (c3[1] < y0) y0 = c3[1]; if (c3[1] > y1) y1 = c3[1]; } clusters.push([comp.length, strong, adj, +occMean.toFixed(2), x0, y0, x1, y1]); }
          if (opt.attach > 0 && comp.length >= opt.attachMin && adj > opt.attach * comp.length) { for (const a of comp) { dyn[a] = 0; dynVox--; } }
        }
      }
    }
    if (clusters && opt.dumpClusters) fs.writeFileSync(opt.dumpClusters, JSON.stringify(clusters));
    // ---- только список движущихся вокселей (для окна приложения: точки там классифицируются по координатам, порядок точек не важен)
    if (opt.voxelsOnly) {
      const keys = new Float64Array(dynVox > 0 ? dynVox : 0); let q = 0;
      for (let k = 0; k < NV && q < keys.length; k++) { if (!dyn[k]) continue; kxyz(k, c3); keys[q++] = c3[0] + nx * (c3[1] + ny * c3[2]); }
      const kk = keys.subarray(0, q).sort();
      const tv = Date.now();
      return { keys: kk, grid: { gx, gy, gz, v, nx, ny, nz }, stats: { points: N, occVox, dynVox: q, blocks: nb, binSec: +binSec.toFixed(2), rays, steps, grid: [nx, ny, nz], origin: [gx, gy, gz],
        ms: { occupancy: t1 - tStart, rays: t2 - t1, decide: tv - t2 } } };
    }
    // ---- проход 3: маска точек
    const mask = new Uint8Array(N); let nDyn = 0, nNear = 0, nFar = 0;
    scanLas(fd, H, (buf, first, c) => {
      for (let j = 0, o = 0; j < c; j++, o += rl) {
        const x = buf.readInt32LE(o) * H.sx + H.ox, y = buf.readInt32LE(o + 4) * H.sy + H.oy, z = buf.readInt32LE(o + 8) * H.sz + H.oz;
        if (opt.nearRange > 0 || opt.farRange > 0) {
          poseAt(buf.readDoubleLE(o + tO), sp); const dx = x - sp[0], dy = y - sp[1], dz = z - sp[2], r2 = dx * dx + dy * dy + dz * dz;
          if (opt.nearRange > 0 && r2 < opt.nearRange * opt.nearRange) { mask[first + j] = 2; nNear++; continue; }
          if (opt.farRange > 0 && r2 > opt.farRange * opt.farRange) { mask[first + j] = 3; nFar++; continue; }
        }
        const ix = Math.floor((x - gx) * iv), iy = Math.floor((y - gy) * iv), iz = Math.floor((z - gz) * iv);
        if (ix < 0 || iy < 0 || iz < 0 || ix >= nx || iy >= ny || iz >= nz) continue;
        const k = vox(ix, iy, iz, false); if (k >= 0 && dyn[k]) { mask[first + j] = 1; nDyn++; }
      }
      prog(0.83 + 0.17 * (first + c) / N, 'маска');
    });
    const t3 = Date.now();
    return { mask, stats: { points: N, dynamic: nDyn, near: nNear, far: nFar, occVox, dynVox, blocks: nb, binSec: +binSec.toFixed(2), rays, steps, grid: [nx, ny, nz], origin: [gx, gy, gz],
      ms: { occupancy: t1 - tStart, rays: t2 - t1, mask: t3 - t2 } } };
  } finally { fs.closeSync(fd); }
}

module.exports = { run, smallestEig, parsePoses, makePoseAt, readLasHeader, scanLas };
