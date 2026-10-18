'use strict';
/*
 * scan-refine-core.js — «чистовая» обработка скана в новый файл LAS (как экспорт после обработки в Lixel Studio), любого размера.
 *   • движущиеся объекты: точки в «движущихся» вокселях (результат dynamic-clean-core.js, voxelsOnly) удаляются;
 *   • одиночный шум: точка без соседей в кубе 30 см удаляется;
 *   • чёткость поверхностей: на плоских участках точки проецируются на локальную плоскость (MLS по ячейкам 4 см) — стена
 *     толщиной 5–10 мм (realtime-карта сканера) становится тонкой, как в Lixel, края, трубы и углы не трогаются;
 *   • цвет: одиночные «пёстрые» точки (блик, пиксель соседнего предмета) получают цвет окрестности.
 * Файл обрабатывается по плиткам (столбцы в плане с перекрытием 20 см): память ограничена размером плитки, а не облака.
 * Проходы: 1) счёт точек по столбцам 1 м → плитки; 2) раскладка во временные файлы; 3) обработка плиток и запись LAS.
 */
const fs = require('node:fs');
const path = require('node:path');

const RGB_OFF = { 2: 20, 3: 28, 5: 28, 7: 30, 8: 30, 10: 30 };

function readHeader(fd) {
  const h = Buffer.alloc(375); fs.readSync(fd, h, 0, 375, 0);
  if (h.toString('latin1', 0, 4) !== 'LASF') throw new Error('файл не LAS');
  const minor = h[25], hsize = h.readUInt16LE(94), off = h.readUInt32LE(96), fmt = h[104] & 0x3f, rl = h.readUInt16LE(105);
  if (h[104] & 0x80) throw new Error('сжатый LAS (LAZ) не поддерживается — нужен обычный LAS');
  let n = h.readUInt32LE(107); if (minor >= 4) { const n2 = Number(h.readBigUInt64LE(247)); if (n2 > 0) n = n2; }
  return { minor, hsize, off, fmt, rl, n, rgb: RGB_OFF[fmt], sx: h.readDoubleLE(131), sy: h.readDoubleLE(139), sz: h.readDoubleLE(147), ox: h.readDoubleLE(155), oy: h.readDoubleLE(163), oz: h.readDoubleLE(171),
    maxX: h.readDoubleLE(179), minX: h.readDoubleLE(187), maxY: h.readDoubleLE(195), minY: h.readDoubleLE(203) };
}

function scan(fd, H, cb, per) {
  per = per || 1 << 19; const buf = Buffer.allocUnsafe(per * H.rl);
  for (let i = 0; i < H.n; i += per) {
    const c = Math.min(per, H.n - i), bytes = c * H.rl; let got = 0;
    while (got < bytes) { const r = fs.readSync(fd, buf, got, bytes - got, H.off + i * H.rl + got); if (!r) throw new Error('файл LAS обрезан'); got += r; }
    cb(buf, i, c);
  }
}

// Хеш-таблица ячеек: ключ (целое ≤ 2^52) → номер ячейки
class Cells {
  constructor(cap0) { let c = 1024; while (c < cap0 * 2) c <<= 1; this.cap = c; this.mask = c - 1; this.K = new Float64Array(c).fill(-1); this.id = new Int32Array(c); this.n = 0; }
  _h(k) { return (Math.imul((k % 4294967296) >>> 0, 2654435761) ^ Math.imul(Math.floor(k / 4294967296), 40503)) & this.mask; }
  get(k, add) {
    let h = this._h(k); const K = this.K;
    while (K[h] !== -1) { if (K[h] === k) return this.id[h]; h = (h + 1) & this.mask; }
    if (!add) return -1;
    if (this.n * 2 >= this.cap) { this._grow(); return this.get(k, true); }
    K[h] = k; this.id[h] = this.n; return this.n++;
  }
  _grow() { const oK = this.K, oI = this.id; this.cap <<= 1; this.mask = this.cap - 1; this.K = new Float64Array(this.cap).fill(-1); this.id = new Int32Array(this.cap);
    for (let i = 0; i < oK.length; i++) { if (oK[i] === -1) continue; let h = this._h(oK[i]); while (this.K[h] !== -1) h = (h + 1) & this.mask; this.K[h] = oK[i]; this.id[h] = oI[i]; } }
}

// ячейки размера cell для точек X (Float64 xyz, относительные): { cid (номер ячейки точки), C (Cells), ix/iy/iz ячеек, nx, ny }
function cellsOf(X, n, cell, alive) {
  let mnx = Infinity, mny = Infinity, mnz = Infinity, mxx = -Infinity, mxy = -Infinity;
  for (let i = 0; i < n; i++) { if (alive && !alive[i]) continue; const x = X[i * 3], y = X[i * 3 + 1], z = X[i * 3 + 2]; if (x < mnx) mnx = x; if (x > mxx) mxx = x; if (y < mny) mny = y; if (y > mxy) mxy = y; if (z < mnz) mnz = z; }
  const nx = Math.floor((mxx - mnx) / cell) + 3, ny = Math.floor((mxy - mny) / cell) + 3, inv = 1 / cell;
  const C = new Cells(n / 4 + 16), cid = new Int32Array(n).fill(-1);
  for (let i = 0; i < n; i++) {
    if (alive && !alive[i]) continue;
    const ix = Math.floor((X[i * 3] - mnx) * inv) + 1, iy = Math.floor((X[i * 3 + 1] - mny) * inv) + 1, iz = Math.floor((X[i * 3 + 2] - mnz) * inv) + 1;
    cid[i] = C.get(ix + nx * (iy + ny * iz), true);
  }
  const m = C.n, cx = new Int32Array(m), cy = new Int32Array(m), cz = new Int32Array(m);
  for (let h = 0; h < C.cap; h++) { const k = C.K[h]; if (k === -1) continue; const j = C.id[h], ix = k % nx, r = (k - ix) / nx, iy = r % ny; cx[j] = ix; cy[j] = iy; cz[j] = (r - iy) / ny; }
  return { cid, C, cx, cy, cz, nx, ny, m };
}
// сумма по 27 соседним ячейкам: A (m×w) → S (m×w)
function nbSum(G, A, w) {
  const S = new Float64Array(G.m * w), nx = G.nx, ny = G.ny;
  for (let j = 0; j < G.m; j++) {
    const x = G.cx[j], y = G.cy[j], z = G.cz[j];
    for (let dz = -1; dz <= 1; dz++) for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      const q = (dx | dy | dz) === 0 ? j : G.C.get((x + dx) + nx * ((y + dy) + ny * (z + dz)), false); if (q < 0) continue;
      for (let a = 0; a < w; a++) S[j * w + a] += A[q * w + a];
    }
  }
  return S;
}
function eig3(a00, a01, a02, a11, a12, a22, out) {   // наименьшее собственное: вектор → out, доля от следа — результат
  const A = [[a00, a01, a02], [a01, a11, a12], [a02, a12, a22]], V = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
  for (let sw = 0; sw < 10; sw++) {
    const off = A[0][1] * A[0][1] + A[0][2] * A[0][2] + A[1][2] * A[1][2]; if (off < 1e-24) break;
    for (let p = 0; p < 2; p++) for (let q = p + 1; q < 3; q++) {
      if (Math.abs(A[p][q]) < 1e-30) continue;
      const th = (A[q][q] - A[p][p]) / (2 * A[p][q]), t = Math.sign(th || 1) / (Math.abs(th) + Math.sqrt(th * th + 1)), c = 1 / Math.sqrt(t * t + 1), s = t * c;
      for (let r = 0; r < 3; r++) { const arp = A[r][p], arq = A[r][q]; A[r][p] = c * arp - s * arq; A[r][q] = s * arp + c * arq; }
      for (let r = 0; r < 3; r++) { const apr = A[p][r], aqr = A[q][r]; A[p][r] = c * apr - s * aqr; A[q][r] = s * apr + c * aqr; }
      for (let r = 0; r < 3; r++) { const vrp = V[r][p], vrq = V[r][q]; V[r][p] = c * vrp - s * vrq; V[r][q] = s * vrp + c * vrq; }
    }
  }
  let i = 0; if (A[1][1] < A[i][i]) i = 1; if (A[2][2] < A[i][i]) i = 2;
  out[0] = V[0][i]; out[1] = V[1][i]; out[2] = V[2][i];
  const tr = A[0][0] + A[1][1] + A[2][2]; return tr > 1e-30 ? Math.max(0, A[i][i]) / tr : 1;
}

/** Плоские участки → на локальную плоскость (ячейки cell, окрестность 3×3×3). Возвращает число сдвинутых точек. */
function thinSurfaces(X, n, alive, o) {
  const cell = o.cell || 0.04, planar = o.planar || 0.06, minPts = o.minPts || 8;
  const G = cellsOf(X, n, cell, alive), m = G.m, A = new Float64Array(m * 10);
  // моменты относительно угла ячейки (без потери точности на больших координатах)
  for (let i = 0; i < n; i++) {
    const j = G.cid[i]; if (j < 0) continue; const b = j * 10;
    const x = X[i * 3], y = X[i * 3 + 1], z = X[i * 3 + 2];
    A[b] += 1; A[b + 1] += x; A[b + 2] += y; A[b + 3] += z; A[b + 4] += x * x; A[b + 5] += x * y; A[b + 6] += x * z; A[b + 7] += y * y; A[b + 8] += y * z; A[b + 9] += z * z;
  }
  const S = nbSum(G, A, 10), mu = new Float64Array(m * 3), nr = new Float32Array(m * 3), wt = new Float32Array(m), ev = new Float64Array(3);
  for (let j = 0; j < m; j++) {
    const b = j * 10, c = S[b]; if (c < minPts) continue;
    const mx = S[b + 1] / c, my = S[b + 2] / c, mz = S[b + 3] / c;
    const curv = eig3(S[b + 4] / c - mx * mx, S[b + 5] / c - mx * my, S[b + 6] / c - mx * mz, S[b + 7] / c - my * my, S[b + 8] / c - my * mz, S[b + 9] / c - mz * mz, ev);
    if (!(curv < planar)) continue;
    mu[j * 3] = mx; mu[j * 3 + 1] = my; mu[j * 3 + 2] = mz; nr[j * 3] = ev[0]; nr[j * 3 + 1] = ev[1]; nr[j * 3 + 2] = ev[2];
    wt[j] = Math.min(1, (planar - curv) / planar * 2);
  }
  let moved = 0;
  for (let i = 0; i < n; i++) {
    const j = G.cid[i]; if (j < 0 || !(wt[j] > 0)) continue;
    const ax = nr[j * 3], ay = nr[j * 3 + 1], az = nr[j * 3 + 2];
    const d = ((X[i * 3] - mu[j * 3]) * ax + (X[i * 3 + 1] - mu[j * 3 + 1]) * ay + (X[i * 3 + 2] - mu[j * 3 + 2]) * az) * wt[j];
    X[i * 3] -= d * ax; X[i * 3 + 1] -= d * ay; X[i * 3 + 2] -= d * az; moved++;
  }
  return moved;
}
/** Цветовые выбросы: яркость точки далеко от средней по окрестности (k·σ, не меньше minDev) → средний цвет окрестности. */
function fixColors(X, RGB, n, alive, o) {
  const cell = o.cell || 0.05, k = o.k || 2, minDev = o.minDev || 18, G = cellsOf(X, n, cell, alive), m = G.m;
  const L = new Float32Array(n), A = new Float64Array(m * 3);
  for (let i = 0; i < n; i++) { const j = G.cid[i]; if (j < 0) continue; const l = 0.299 * RGB[i * 3] + 0.587 * RGB[i * 3 + 1] + 0.114 * RGB[i * 3 + 2]; L[i] = l; A[j * 3] += 1; A[j * 3 + 1] += l; A[j * 3 + 2] += l * l; }
  const S = nbSum(G, A, 3), out = new Uint8Array(n), B = new Float64Array(m * 4); let nOut = 0;
  for (let i = 0; i < n; i++) {
    const j = G.cid[i]; if (j < 0) continue; const c = S[j * 3]; if (c < 10) { B[j * 4] += 1; B[j * 4 + 1] += RGB[i * 3]; B[j * 4 + 2] += RGB[i * 3 + 1]; B[j * 4 + 3] += RGB[i * 3 + 2]; continue; }
    const mu = S[j * 3 + 1] / c, sd = Math.sqrt(Math.max(0, S[j * 3 + 2] / c - mu * mu));
    if (Math.abs(L[i] - mu) > Math.max(minDev, k * sd)) { out[i] = 1; nOut++; continue; }
    B[j * 4] += 1; B[j * 4 + 1] += RGB[i * 3]; B[j * 4 + 2] += RGB[i * 3 + 1]; B[j * 4 + 3] += RGB[i * 3 + 2];
  }
  if (!nOut) return 0;
  const S2 = nbSum(G, B, 4);
  for (let i = 0; i < n; i++) { if (!out[i]) continue; const j = G.cid[i], c = S2[j * 4]; if (!(c > 0)) continue; RGB[i * 3] = S2[j * 4 + 1] / c; RGB[i * 3 + 1] = S2[j * 4 + 2] / c; RGB[i * 3 + 2] = S2[j * 4 + 3] / c; }
  return nOut;
}
/** Одиночный шум: в кубе 3×3×3 ячеек (по 10 см) не больше maxNb точек, включая саму → удалить. */
function isolated(X, n, alive, o) {
  const cell = o.cell || 0.1, maxNb = o.maxNb || 2, G = cellsOf(X, n, cell, alive), A = new Float64Array(G.m);
  for (let i = 0; i < n; i++) { const j = G.cid[i]; if (j >= 0) A[j]++; }
  const S = nbSum(G, A, 1); let r = 0;
  for (let i = 0; i < n; i++) { const j = G.cid[i]; if (j >= 0 && S[j] <= maxNb) { alive[i] = 0; r++; } }
  return r;
}

/**
 * refine(src, dst, opt, onProgress) → stats. opt: { dynamic: { keys, grid } | null, noise, thin, color, tileMax, tmpDir }
 */
function refine(src, dst, opt, onProgress) {
  opt = Object.assign({ noise: true, thin: true, color: true, tileMax: 4000000, halo: 0.2, thinCell: 0.04, planar: 0.06 }, opt || {});
  const prog = typeof onProgress === 'function' ? onProgress : () => {};
  let fd = fs.openSync(src, 'r'); const H = readHeader(fd), N = H.n, rl = H.rl;
  const tmp = fs.mkdtempSync(path.join(opt.tmpDir || path.dirname(dst), '.refine-'));
  const t0 = Date.now(); let ofd = null;
  try {
    // ---- 1: счёт по столбцам 1 м (габариты — из заголовка)
    const CS = 1, x0 = Math.floor(H.minX) - 1, y0 = Math.floor(H.minY) - 1, ncx = Math.ceil(H.maxX - x0) + 2, ncy = Math.ceil(H.maxY - y0) + 2;
    if (!(ncx > 0 && ncy > 0) || ncx * ncy > 64e6) throw new Error('габариты облака в заголовке LAS некорректны');
    const cnt = new Float64Array(ncx * ncy);
    let colorMax = 0;
    scan(fd, H, (b, first, c) => {
      for (let j = 0, o = 0; j < c; j++, o += rl) {
        const x = b.readInt32LE(o) * H.sx + H.ox, y = b.readInt32LE(o + 4) * H.sy + H.oy;
        let cx = Math.floor((x - x0) / CS), cy = Math.floor((y - y0) / CS); if (cx < 0) cx = 0; else if (cx >= ncx) cx = ncx - 1; if (cy < 0) cy = 0; else if (cy >= ncy) cy = ncy - 1;
        cnt[cy * ncx + cx]++;
        if (H.rgb !== undefined && (j & 255) === 0) { const r = b.readUInt16LE(o + H.rgb); if (r > colorMax) colorMax = r; }
      }
      prog(0.15 * (first + c) / N, 'Разметка плиток…');
    });
    const c16 = colorMax > 255;
    // ---- плитки: прямоугольники столбцов, делятся пополам, пока точек больше tileMax
    const tiles = [], tileOf = new Int32Array(ncx * ncy).fill(-1);
    const sumRect = (a, b2, c2, d) => { let s = 0; for (let y = b2; y < d; y++) for (let x = a; x < c2; x++) s += cnt[y * ncx + x]; return s; };
    const split = (a, b2, c2, d, s) => {
      if (s === 0) return;
      if (s <= opt.tileMax || (c2 - a <= 1 && d - b2 <= 1)) { const id = tiles.length; tiles.push({ a, b: b2, c: c2, d, n: s }); for (let y = b2; y < d; y++) for (let x = a; x < c2; x++) tileOf[y * ncx + x] = id; return; }
      if (c2 - a >= d - b2) { const m = (a + c2) >> 1, s1 = sumRect(a, b2, m, d); split(a, b2, m, d, s1); split(m, b2, c2, d, s - s1); }
      else { const m = (b2 + d) >> 1, s1 = sumRect(a, b2, c2, m); split(a, b2, c2, m, s1); split(a, m, c2, d, s - s1); }
    };
    split(0, 0, ncx, ncy, N);
    // ---- 2: раскладка по временным файлам (запись = исходная запись + 1 байт: 0 — своя точка, 1 — перекрытие соседа)
    const RS = rl + 1, BUF = Math.max(RS * 4096, Math.min(1 << 20, Math.floor((256 << 20) / Math.max(1, tiles.length)))), bufs = tiles.map(() => null), fill = new Int32Array(tiles.length);
    const flush = (t) => { if (!fill[t]) return; fs.appendFileSync(path.join(tmp, t + '.bin'), bufs[t].subarray(0, fill[t])); fill[t] = 0; };
    const put = (t, b, o, flag) => { if (!bufs[t]) bufs[t] = Buffer.allocUnsafe(BUF - (BUF % RS)); if (fill[t] + RS > bufs[t].length) flush(t); b.copy(bufs[t], fill[t], o, o + rl); bufs[t][fill[t] + rl] = flag; fill[t] += RS; };
    const hal = opt.halo, near = new Int32Array(8);
    scan(fd, H, (b, first, c) => {
      for (let j = 0, o = 0; j < c; j++, o += rl) {
        const x = b.readInt32LE(o) * H.sx + H.ox, y = b.readInt32LE(o + 4) * H.sy + H.oy;
        const fx = (x - x0) / CS, fy = (y - y0) / CS; let cx = Math.floor(fx), cy = Math.floor(fy); if (cx < 0) cx = 0; else if (cx >= ncx) cx = ncx - 1; if (cy < 0) cy = 0; else if (cy >= ncy) cy = ncy - 1;
        const t = tileOf[cy * ncx + cx]; put(t, b, o, 0);
        const ux = fx - cx, uy = fy - cy, lx = ux < hal ? -1 : (ux > 1 - hal ? 1 : 0), ly = uy < hal ? -1 : (uy > 1 - hal ? 1 : 0);
        if (lx || ly) {
          let k = 0;
          for (const [dx, dy] of [[lx, 0], [0, ly], [lx, ly]]) {
            if (!dx && !dy) continue; const X = cx + dx, Y = cy + dy; if (X < 0 || Y < 0 || X >= ncx || Y >= ncy) continue;
            const t2 = tileOf[Y * ncx + X]; if (t2 < 0 || t2 === t) continue; let dup = false; for (let q = 0; q < k; q++) if (near[q] === t2) dup = true; if (dup) continue; near[k++] = t2; put(t2, b, o, 1);
          }
        }
      }
      prog(0.15 + 0.3 * (first + c) / N, 'Раскладка точек по плиткам…');
    });
    for (let t = 0; t < tiles.length; t++) { flush(t); bufs[t] = null; }
    fs.closeSync(fd); fd = null;
    // ---- 3: обработка плиток и запись
    const hdr = Buffer.alloc(H.off); { const f2 = fs.openSync(src, 'r'); fs.readSync(f2, hdr, 0, H.off, 0); fs.closeSync(f2); }
    ofd = fs.openSync(dst, 'w+'); fs.writeSync(ofd, hdr, 0, H.off, 0);
    let wpos = H.off, out = 0, nDyn = 0, nNoise = 0, nMoved = 0, nColor = 0, done = 0;
    let bx0 = Infinity, by0 = Infinity, bz0 = Infinity, bx1 = -Infinity, by1 = -Infinity, bz1 = -Infinity;
    const DV = opt.dynamic && opt.dynamic.keys && opt.dynamic.keys.length ? require('./renderer/dynamic-voxels').build(opt.dynamic.keys, opt.dynamic.grid) : null;
    for (let t = 0; t < tiles.length; t++) {
      const f = path.join(tmp, t + '.bin'); if (!fs.existsSync(f)) continue;
      const B = fs.readFileSync(f); fs.unlinkSync(f);
      const n = Math.floor(B.length / RS), X = new Float64Array(n * 3), alive = new Uint8Array(n).fill(1), own = new Uint8Array(n);
      const RGB = H.rgb !== undefined ? new Float32Array(n * 3) : null;
      const T = tiles[t], cxm = x0 + (T.a + T.c) / 2 * CS, cym = y0 + (T.b + T.d) / 2 * CS;
      let zs = 0;
      for (let i = 0, o = 0; i < n; i++, o += RS) {
        const x = B.readInt32LE(o) * H.sx + H.ox, y = B.readInt32LE(o + 4) * H.sy + H.oy, z = B.readInt32LE(o + 8) * H.sz + H.oz;
        X[i * 3] = x - cxm; X[i * 3 + 1] = y - cym; X[i * 3 + 2] = z; zs += z; own[i] = B[o + rl] === 0 ? 1 : 0;
        if (RGB) { const s = c16 ? 1 / 256 : 1; RGB[i * 3] = B.readUInt16LE(o + H.rgb) * s; RGB[i * 3 + 1] = B.readUInt16LE(o + H.rgb + 2) * s; RGB[i * 3 + 2] = B.readUInt16LE(o + H.rgb + 4) * s; }
        if (DV && DV.has(x, y, z)) { alive[i] = 0; if (own[i]) nDyn++; }
      }
      const zm = n ? zs / n : 0; for (let i = 0; i < n; i++) X[i * 3 + 2] -= zm;
      if (opt.noise) { const before = alive.reduce((a, v, i) => a + (v && own[i] ? 1 : 0), 0); isolated(X, n, alive, { cell: 0.1, maxNb: opt.noiseMax || 2 }); nNoise += before - alive.reduce((a, v, i) => a + (v && own[i] ? 1 : 0), 0); }
      if (opt.thin) { for (let it = 0; it < (opt.thinIters || 1); it++) nMoved += thinSurfaces(X, n, alive, { cell: opt.thinCell, planar: opt.planar }); }
      if (opt.color && RGB) nColor += fixColors(X, RGB, n, alive, { cell: 0.05 });
      // запись своих живых точек: исходная запись с новыми координатами и цветом
      let k = 0; for (let i = 0; i < n; i++) if (alive[i] && own[i]) k++;
      const O = Buffer.allocUnsafe(k * rl); let w = 0;
      for (let i = 0, o = 0; i < n; i++, o += RS) {
        if (!alive[i] || !own[i]) continue;
        B.copy(O, w, o, o + rl);
        const x = X[i * 3] + cxm, y = X[i * 3 + 1] + cym, z = X[i * 3 + 2] + zm;
        O.writeInt32LE(Math.round((x - H.ox) / H.sx), w); O.writeInt32LE(Math.round((y - H.oy) / H.sy), w + 4); O.writeInt32LE(Math.round((z - H.oz) / H.sz), w + 8);
        if (RGB) { const s = c16 ? 256 : 1; for (let a = 0; a < 3; a++) { const v = Math.round(RGB[i * 3 + a] * s); O.writeUInt16LE(v < 0 ? 0 : (v > 65535 ? 65535 : v), w + H.rgb + a * 2); } }
        if (x < bx0) bx0 = x; if (x > bx1) bx1 = x; if (y < by0) by0 = y; if (y > by1) by1 = y; if (z < bz0) bz0 = z; if (z > bz1) bz1 = z;
        w += rl;
      }
      fs.writeSync(ofd, O, 0, w, wpos); wpos += w; out += k; done += T.n;
      prog(0.45 + 0.55 * done / N, 'Обработка плиток…');
    }
    // заголовок: число точек, по возвратам, габариты; EVLR не переносятся
    const h = Buffer.alloc(Math.min(H.off, 375)); fs.readSync(ofd, h, 0, h.length, 0);
    if (out <= 0xffffffff) h.writeUInt32LE(H.minor >= 4 && H.fmt >= 6 ? 0 : out, 107); else h.writeUInt32LE(0, 107);
    for (let r = 0; r < 5; r++) h.writeUInt32LE(r === 0 && out <= 0xffffffff && !(H.minor >= 4 && H.fmt >= 6) ? out : 0, 111 + r * 4);
    h.writeDoubleLE(bx1, 179); h.writeDoubleLE(bx0, 187); h.writeDoubleLE(by1, 195); h.writeDoubleLE(by0, 203); h.writeDoubleLE(bz1, 211); h.writeDoubleLE(bz0, 219);
    if (H.minor >= 3 && h.length >= 235) h.writeBigUInt64LE(0n, 227);
    if (H.minor >= 4 && h.length >= 375) { h.writeBigUInt64LE(0n, 235); h.writeUInt32LE(0, 243); h.writeBigUInt64LE(BigInt(out), 247); h.writeBigUInt64LE(BigInt(out), 255); for (let r = 1; r < 15; r++) h.writeBigUInt64LE(0n, 255 + r * 8); }
    fs.writeSync(ofd, h, 0, h.length, 0); fs.ftruncateSync(ofd, wpos); fs.closeSync(ofd); ofd = null;
    return { points: N, written: out, dynamic: nDyn, noise: nNoise, moved: nMoved, recolored: nColor, tiles: tiles.length, ms: Date.now() - t0, color16: c16 };
  } finally {
    if (fd !== null) { try { fs.closeSync(fd); } catch (_) {} }
    if (ofd !== null) { try { fs.closeSync(ofd); } catch (_) {} }
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) {}
  }
}

module.exports = { refine, readHeader, thinSurfaces, fixColors, isolated, cellsOf, eig3 };
