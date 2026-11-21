'use strict';
/**
 * recolor-post.js — r179: глобальная пост-обработка цвета после ПАРАЛЛЕЛЬНОЙ раскраски по тайлам.
 *
 * Параллельные тайлы красят точки «в своих» кадрах; заполнение серых зон и денойз по 2-см соседям
 * нужно делать глобально (иначе на границах тайлов теряется плотность/качество). Здесь они делаются
 * потоково по LAS за ДВА прохода (память O(ячеек)):
 *
 *   pass1: серый исходник + цветной LAS → 3D-ячейки 15 см (цветные точки) + 2D-сетка 2 см (денойз);
 *   заливка: пустые ячейки получают средний цвет соседних (несколько итераций);
 *   pass2: серая точка → цвет ячейки; цветная → при необходимости усредняется по 2-см ячейке
 *          (если это не край: перепад >70 между ячейками, или точка-выброс >200).
 *
 * Проверка диапазона строк (rowRange) позволяет распараллелить по тайлам времени:
 * каждый воркер читает свои строки + запас соседей (margin), а пишет только свои.
 *
 *   postColor(grayPath, colorIn, colorOut, opt, log) → Promise<stats>
 *   postParallel({gray, colorIn, colorOut, ranges, workers, opt, log}) → Promise<stats>
 */
const fs = require('node:fs');

const HDR = 375;

function readHead(fd) {
  const h = Buffer.alloc(HDR);
  let got = 0;
  while (got < HDR) { const n = fs.readSync(fd, h, got, HDR - got, got); if (!n) break; got += n; }
  if (h.toString('latin1', 0, 4) !== 'LASF') throw new Error('не LAS');
  const minor = h[25], off = h.readUInt32LE(96), fmt = h[104] & 0x3f, rl = h.readUInt16LE(105);
  let n = h.readUInt32LE(107);
  if (minor >= 4) { const n2 = Number(h.readBigUInt64LE(247)); if (n2 > 0) n = n2; }
  const bb = [h.readDoubleLE(187), h.readDoubleLE(203), h.readDoubleLE(219), h.readDoubleLE(179), h.readDoubleLE(195), h.readDoubleLE(211)]; // minx,miny,minz,maxx,maxy,maxz
  const RGB = { 2: 20, 3: 28, 5: 28, 7: 30, 8: 30, 10: 30 }[fmt];
  if (RGB == null) throw new Error('в LAS нет RGB (формат ' + fmt + ')');
  return { minor, off, fmt, rl, n, rgb: RGB, bb, header: h,
    sx: h.readDoubleLE(131), sy: h.readDoubleLE(139), sz: h.readDoubleLE(147), ox: h.readDoubleLE(155), oy: h.readDoubleLE(163), oz: h.readDoubleLE(171) };
}

function readChunk(fd, buf, pos, len) {
  let got = 0;
  while (got < len) { const n = fs.readSync(fd, buf, got, len - got, pos + got); if (!n) break; got += n; }
  return got;
}

async function runPost(grayPath, colorIn, colorOut, opt, range, log) {
  opt = opt || {};
  const t0 = Date.now();
  const st = { passes: 2, fill: null, denoise: null, ms: 0 };
  const finC = fs.openSync(colorIn, 'r'), finG = fs.openSync(grayPath, 'r');
  try {
    const H = readHead(finC), Hg = readHead(finG);
    if (Hg.n !== H.n) throw new Error('число точек серого и цветного LAS не совпадает');
    const RGB = H.rgb, RL = H.rl, N = H.n;
    const start = range ? Math.max(0, range.start | 0) : 0;
    const count = range ? Math.min(N - start, range.count | 0) : N;
    const margin = range ? Math.max(0, range.margin | 0) : 0;
    const r0 = Math.max(0, start - margin), r1 = Math.min(N, start + count + margin);
    const CH = Math.max(1024, Math.floor((8 << 20) / RL));
    const bufC = Buffer.allocUnsafe(CH * RL), bufG = Buffer.allocUnsafe(CH * RL);
    const xyz = new Float64Array(3);
    const at = (q) => { xyz[0] = bufC.readInt32LE(q) * H.sx + H.ox; xyz[1] = bufC.readInt32LE(q + 4) * H.sy + H.oy; xyz[2] = bufC.readInt32LE(q + 8) * H.sz + H.oz; };

    // ---------- ячейки заливки (15 см) ----------
    const fillCell = Math.max(0.05, opt.fillCell || 0.15);
    const fillR = Math.max(1, Math.ceil((opt.fillRadius || 0.3) / fillCell));
    const fillIters = Math.max(1, opt.fillIters | 0 || 2);
    const B0 = 8192, OFF = 4096;
    const keyOf = (x, y, z) => {
      const ix = Math.floor(x / fillCell) + OFF, iy = Math.floor(y / fillCell) + OFF, iz = Math.floor(z / fillCell) + OFF;
      if (ix < 0 || iy < 0 || iz < 0 || ix >= B0 || iy >= B0 || iz >= B0) return -1;
      return (ix * B0 + iy) * B0 + iz;
    };
    const offs = [];
    for (let dx = -fillR; dx <= fillR; dx++) for (let dy = -fillR; dy <= fillR; dy++) for (let dz = -fillR; dz <= fillR; dz++) {
      if (dx * dx + dy * dy + dz * dz > fillR * fillR) continue;
      offs.push(dx * B0 * B0 + dy * B0 + dz);
    }
    const cellMap = new Map(), cellKeys = [];
    let cap = 1 << 16; let cR = new Float64Array(cap), cG = new Float64Array(cap), cB = new Float64Array(cap), cN = new Uint32Array(cap), cCol = new Uint8Array(cap), nc = 0;
    const grow = () => { cap <<= 1; const g = (a, T) => { const b2 = new T(cap); b2.set(a); return b2; }; cR = g(cR, Float64Array); cG = g(cG, Float64Array); cB = g(cB, Float64Array); cN = g(cN, Uint32Array); cCol = g(cCol, Uint8Array); };
    const getCell = (k) => { let ci = cellMap.get(k); if (ci === undefined) { if (nc >= cap) grow(); ci = nc++; cellMap.set(k, ci); cellKeys.push(k); } return ci; };
    const colOf = (b, q) => b[q + RGB] | (b[q + RGB + 2] << 8) | (b[q + RGB + 4] << 16);
    const colOfG = (b, q) => b[q + Hg.rgb] | (b[q + Hg.rgb + 2] << 8) | (b[q + Hg.rgb + 4] << 16);

    // ---------- сетка денойза 2 см ----------
    const bb = H.bb;
    const ext = [bb[3] - bb[0], bb[4] - bb[1], bb[5] - bb[2]];
    let drop = 0; for (let a = 1; a < 3; a++) if (ext[a] < ext[drop]) drop = a;
    const axes = [0, 1, 2].filter(a => a !== drop), A1 = axes[0], A2 = axes[1];
    const los = [bb[0], bb[1], bb[2]], his = [bb[3], bb[4], bb[5]];
    let dcell = Math.max(0.005, opt.denoiseCell || 0.02);
    const lo1 = los[A1], lo2 = los[A2], hi1 = his[A1], hi2 = his[A2];
    let nU = Math.floor((hi1 - lo1) / dcell) + 2, nV = Math.floor((hi2 - lo2) / dcell) + 2;
    if (nU * nV > 12000000) { const sc = Math.sqrt(nU * nV / 12000000); dcell *= sc; nU = Math.floor((hi1 - lo1) / dcell) + 2; nV = Math.floor((hi2 - lo2) / dcell) + 2; }
    const NG = nU * nV;
    const dR = new Float32Array(NG), dG = new Float32Array(NG), dB = new Float32Array(NG), dN = new Uint32Array(NG);
    const cellXY = () => {
      let iu = ((xyz[A1] - lo1) / dcell) | 0, iv = ((xyz[A2] - lo2) / dcell) | 0;
      if (iu < 0) iu = 0; else if (iu >= nU) iu = nU - 1;
      if (iv < 0) iv = 0; else if (iv >= nV) iv = nV - 1;
      return iu + iv * nU;
    };

    // ---------- pass 1 ----------
    let colored = 0;
    for (let i = r0; i < r1; i += CH) {
      const c = Math.min(CH, r1 - i);
      readChunk(finC, bufC, H.off + i * RL, c * RL);
      readChunk(finG, bufG, H.off + i * RL, c * RL);
      for (let j = 0, q = 0; j < c; j++, q += RL) {
        at(q);
        const k = keyOf(xyz[0], xyz[1], xyz[2]); if (k < 0) continue;
        const ci = getCell(k);
        const col = colOf(bufC, q);
        if (col === colOfG(bufG, q)) continue;
        colored++;
        cR[ci] += col & 255; cG[ci] += (col >>> 8) & 255; cB[ci] += (col >>> 16) & 255; cN[ci]++;
        const k2 = cellXY();
        dR[k2] += col & 255; dG[k2] += (col >>> 8) & 255; dB[k2] += (col >>> 16) & 255; dN[k2]++;
      }
    }
    let coloredCells = 0; const colIdx = [];
    for (let ci = 0; ci < nc; ci++) { const n = cN[ci]; if (!n) continue; cR[ci] /= n; cG[ci] /= n; cB[ci] /= n; cCol[ci] = 1; coloredCells++; colIdx.push(ci); }
    // заливка по ячейкам
    const keys = Array.from(cellMap.keys());
    for (let it = 0; it < fillIters; it++) {
      let added = 0;
      for (let q = 0; q < keys.length; q++) {
        const k = keys[q], ci = cellMap.get(k); if (cCol[ci]) continue;
        let r = 0, g = 0, b = 0, cnt = 0;
        for (let oi = 0; oi < offs.length; oi++) { const cj = cellMap.get(k + offs[oi]); if (cj === undefined || !cCol[cj]) continue; r += cR[cj]; g += cG[cj]; b += cB[cj]; cnt++; }
        if (!cnt) continue;
        cR[ci] = r / cnt; cG[ci] = g / cnt; cB[ci] = b / cnt; cCol[ci] = 1; added++;
      }
      if (!added) break;
    }
    // средние/края для денойза
    const valid = new Uint8Array(NG);
    const minPts = opt.denoiseMinPts || 3;
    let vcells = 0;
    for (let k = 0; k < NG; k++) { const n = dN[k]; if (!n || n < minPts) continue; dR[k] /= n; dG[k] /= n; dB[k] /= n; valid[k] = 1; vcells++; }
    const edgeCell = new Uint8Array(NG); const edgeThr = opt.denoiseEdge || 70; let edgeCells = 0;
    for (let iv = 0; iv < nV; iv++) for (let iu = 0; iu < nU; iu++) {
      const k = iu + iv * nU; if (!valid[k]) continue;
      let mx = 0;
      if (iu > 0 && valid[k - 1]) mx = Math.max(mx, Math.abs(dR[k] - dR[k - 1]), Math.abs(dG[k] - dG[k - 1]), Math.abs(dB[k] - dB[k - 1]));
      if (iu + 1 < nU && valid[k + 1]) mx = Math.max(mx, Math.abs(dR[k] - dR[k + 1]), Math.abs(dG[k] - dG[k + 1]), Math.abs(dB[k] - dB[k + 1]));
      if (iv > 0 && valid[k - nU]) mx = Math.max(mx, Math.abs(dR[k] - dR[k - nU]), Math.abs(dG[k] - dG[k - nU]), Math.abs(dB[k] - dB[k - nU]));
      if (iv + 1 < nV && valid[k + nU]) mx = Math.max(mx, Math.abs(dR[k] - dR[k + nU]), Math.abs(dG[k] - dG[k + nU]), Math.abs(dB[k] - dB[k + nU]));
      if (mx > edgeThr) { edgeCell[k] = 1; edgeCells++; }
    }
    // крупные сетки-фолбэки: добивают далёкие/скрытые серые зоны (99%+ покрытия), цвет ближайшей поверхности
    const coarse = [];
    for (const cs of [fillCell * 6, fillCell * 36, fillCell * 216]) {
      const map = new Map();
      let cc = 0; let sR = new Float64Array(1 << 16), sG = new Float64Array(1 << 16), sB = new Float64Array(1 << 16), sN = new Uint32Array(1 << 16);
      const growC = () => { const b2 = new Float64Array(sR.length << 1); b2.set(sR); sR = b2; const b3 = new Float64Array(sG.length << 1); b3.set(sG); sG = b3; const b4 = new Float64Array(sB.length << 1); b4.set(sB); sB = b4; const b5 = new Uint32Array(sN.length << 1); b5.set(sN); sN = b5; };
      const keyAt = (x, y, z) => {
        const ix = Math.floor(x / cs) + OFF, iy = Math.floor(y / cs) + OFF, iz = Math.floor(z / cs) + OFF;
        if (ix < 0 || iy < 0 || iz < 0 || ix >= B0 || iy >= B0 || iz >= B0) return -1;
        return (ix * B0 + iy) * B0 + iz;
      };
      for (let q = 0; q < colIdx.length; q++) {
        const ci = colIdx[q], k = cellKeys[ci];
        const iz = k % B0, iy = Math.floor(k / B0) % B0, ix = Math.floor(k / (B0 * B0));
        const x = (ix - OFF + 0.5) * fillCell, y = (iy - OFF + 0.5) * fillCell, z = (iz - OFF + 0.5) * fillCell;
        const k2 = keyAt(x, y, z); if (k2 < 0) continue;
        let cj = map.get(k2); if (cj === undefined) { if (cc >= sR.length) growC(); cj = cc++; map.set(k2, cj); }
        sR[cj] += cR[ci]; sG[cj] += cG[ci]; sB[cj] += cB[ci]; sN[cj]++;
      }
      for (let cj = 0; cj < cc; cj++) { const n = sN[cj]; if (!n) continue; sR[cj] /= n; sG[cj] /= n; sB[cj] /= n; }
      coarse.push({ cs, map, sR, sG, sB, sN, keyAt });
    }
    const coarseColor = (x, y, z) => {
      for (let i = 0; i < coarse.length; i++) {
        const L = coarse[i], k = L.keyAt(x, y, z); if (k < 0) continue;
        const cj = L.map.get(k); if (cj === undefined) continue;
        return [L.sR[cj], L.sG[cj], L.sB[cj]];
      }
      return null;
    };
    // ---------- pass 2 ----------
    const fout = fs.openSync(colorOut, 'w');
    try {
      const head = Buffer.alloc(H.off); readChunk(finC, head, 0, H.off);
      head.writeUInt32LE(count, 107);
      if (H.minor >= 4) head.writeBigUInt64LE(BigInt(count), 247);
      fs.writeSync(fout, head, 0, H.off, 0);
      let w = H.off, filled = 0, replaced = 0, edgeKept = 0;
      const pointEdge = opt.denoiseEdgePoint || 200;
      for (let i = start; i < start + count; i += CH) {
        const c = Math.min(CH, start + count - i);
        readChunk(finC, bufC, H.off + i * RL, c * RL);
        readChunk(finG, bufG, H.off + i * RL, c * RL);
        for (let j = 0, q = 0; j < c; j++, q += RL) {
          at(q);
          const gray = colOfG(bufG, q), col = colOf(bufC, q);
          let r, g, b;
          if (col === gray) {
            const k = keyOf(xyz[0], xyz[1], xyz[2]);
            const ci = k >= 0 ? cellMap.get(k) : undefined;
            if (ci !== undefined && cCol[ci]) {
              r = cR[ci]; g = cG[ci]; b = cB[ci];
              const L = 0.299 * r + 0.587 * g + 0.114 * b; r = L + (r - L) * 2.0; g = L + (g - L) * 2.0; b = L + (b - L) * 2.0;
              const L2 = 0.299 * r + 0.587 * g + 0.114 * b; if (L2 < 42) { const kk = 42 / Math.max(1, L2); r *= kk; g *= kk; b *= kk; }
            } else {
              const cc2 = coarseColor(xyz[0], xyz[1], xyz[2]);
              if (!cc2) continue;   // нечем залить — остаётся серой
              r = cc2[0]; g = cc2[1]; b = cc2[2];
            }
            filled++;
          } else { r = col & 255; g = (col >>> 8) & 255; b = (col >>> 16) & 255; }
          // денойз: 2-см ячейка, кроме краёв и выбросов
          const k2 = cellXY();
          if (valid[k2] && !edgeCell[k2]) {
            const rr = dR[k2], gg = dG[k2], bb2 = dB[k2];
            if (Math.max(Math.abs(r - rr), Math.abs(g - gg), Math.abs(b - bb2)) > pointEdge) edgeKept++;
            else { r = rr; g = gg; b = bb2; if (col !== gray) replaced++; }
          }
          bufC[q + RGB] = Math.max(0, Math.min(255, Math.round(r)));
          bufC[q + RGB + 2] = Math.max(0, Math.min(255, Math.round(g)));
          bufC[q + RGB + 4] = Math.max(0, Math.min(255, Math.round(b)));
        }
        fs.writeSync(fout, bufC, 0, c * RL, w); w += c * RL;
      }
      const end = H.off + (start + count) * RL;
      if (!range && fs.fstatSync(finC).size > end) { const tail = Buffer.alloc(Math.min(fs.fstatSync(finC).size - end, 64 << 20)); readChunk(finC, tail, end, tail.length); fs.writeSync(fout, tail, 0, tail.length, w); }
      st.fill = { colored, coloredCells, filled, cell: fillCell, radius: fillR * fillCell, iters: fillIters };
      st.denoise = { cell: +dcell.toFixed(4), grid: [nU, nV], cells: vcells, filled, replaced, edgeKept, edgeCells, edgeThr };
    } finally { fs.closeSync(fout); }
  } finally {
    try { fs.closeSync(finC); } catch (_) {}
    try { fs.closeSync(finG); } catch (_) {}
  }
  st.colored = (st.fill && st.fill.colored || 0) + (st.fill && st.fill.filled || 0);
  st.ms = Date.now() - t0;
  if (log) log('post: цветных ' + (st.fill ? st.fill.colored : 0) + ', залито ' + (st.fill ? st.fill.filled : 0) + ', денойз ячеек ' + (st.denoise ? st.denoise.cells : 0) + ', ' + st.ms + ' мс');
  return st;
}

function postColor(grayPath, colorIn, colorOut, opt, log) { return runPost(grayPath, colorIn, colorOut, opt || {}, null, log); }

// Параллельная пост-обработка по диапазонам строк (тайлы времени). Каждый воркер читает свои строки
// + запас соседей (margin), пишет только свои — затем куски склеиваются в исходном порядке.
async function postParallel(cfg) {
  const { gray, colorIn, colorOut, ranges, workers, opt, log } = cfg;
  const w = Math.max(1, Math.min(32, workers | 0));
  const head = (() => { const fd = fs.openSync(colorIn, 'r'); try { return readHead(fd); } finally { fs.closeSync(fd); } })();
  const pieces = ranges.map((r, i) => ({ start: r.start | 0, count: r.count | 0, margin: Math.max(20000, r.margin | 0), path: colorOut + '.p' + i, i }));
  const t0 = Date.now();
  const { Worker } = require('node:worker_threads');
  const results = new Array(pieces.length).fill(null);
  let active = 0, next = 0, done = 0;
  const total = head.n;
  await new Promise((resolve, reject) => {
    const pump = () => {
      if (active >= w || next >= pieces.length) { if (active === 0 && next >= pieces.length) resolve(); return; }
      const p = pieces[next++]; active++;
      const wk = new Worker(__filename, { workerData: { run: true, gray, colorIn, colorOut: p.path, opt: opt || {}, range: { start: p.start, count: p.count, margin: p.margin } } });
      let err = null;
      wk.on('message', (m) => { if (m && m.stats) results[p.i] = m.stats; });
      wk.on('error', (e) => { err = e; });
      wk.on('exit', () => {
        active--; done++;
        if (err) reject(err);
        else pump();
      });
    };
    pump();
  });
  // склейка кусков
  const fout = fs.openSync(colorOut, 'w');
  let wpos = head.off;
  try {
    const h3 = Buffer.alloc(head.off); { const fd = fs.openSync(colorIn, 'r'); try { readChunk(fd, h3, 0, head.off); } finally { fs.closeSync(fd); } }
    h3.writeUInt32LE(total, 107);
    if (head.minor >= 4) h3.writeBigUInt64LE(BigInt(total), 247);
    fs.writeSync(fout, h3, 0, head.off, 0);
    for (const p of pieces) {
      const fd = fs.openSync(p.path, 'r');
      try {
        const chunk = Buffer.alloc(1 << 20);
        let left = p.count * head.rl, pos = head.off;
        while (left > 0) { const c = Math.min(chunk.length, left); readChunk(fd, chunk, pos, c); fs.writeSync(fout, chunk, 0, c, wpos); wpos += c; pos += c; left -= c; }
      } finally { fs.closeSync(fd); }
      try { fs.rmSync(p.path, { force: true }); } catch (_) {}
    }
  } finally { fs.closeSync(fout); }
  const fill = { colored: 0, filled: 0, coloredCells: 0, cell: (opt || {}).fillCell || 0.15, radius: (opt || {}).fillRadius || 0.3, iters: (opt || {}).fillIters || 2 };
  const den = { cells: 0, replaced: 0, edgeKept: 0, edgeCells: 0 };
  for (const r of results) { if (!r) continue; fill.colored += (r.fill && r.fill.colored) || 0; fill.filled += (r.fill && r.fill.filled) || 0; fill.coloredCells += (r.fill && r.fill.coloredCells) || 0; den.cells += (r.denoise && r.denoise.cells) || 0; den.replaced += (r.denoise && r.denoise.replaced) || 0; den.edgeKept += (r.denoise && r.denoise.edgeKept) || 0; den.edgeCells += (r.denoise && r.denoise.edgeCells) || 0; }
  if (log) log('post parallel: ' + pieces.length + ' кусков, цветных ' + fill.colored + ', залито ' + fill.filled + ', ' + (Date.now() - t0) + ' мс');
  return { passes: 2, fill, denoise: den, colored: fill.colored + fill.filled, ms: Date.now() - t0, pieces: pieces.length };
}

// --- entry для worker_threads ---
let wd = null;
try { wd = require('node:worker_threads').workerData; } catch (_) {}
if (wd && wd.run) {
  runPost(wd.gray, wd.colorIn, wd.colorOut, wd.opt, wd.range)
    .then(st => { require('node:worker_threads').parentPort.postMessage({ stats: st }); })
    .catch(e => { throw e; });
}

module.exports = { postColor, postParallel, readHead };
