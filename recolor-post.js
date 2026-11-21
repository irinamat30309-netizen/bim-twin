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

// r183: 16-битный RGB (LAS RGB 16 бит) — читаем/пишем как 8-битные значения (v16>>8 / v*257)
function detectC16(fd, H) {
  try {
    const n0 = Math.min(4096, H.n); if (!n0) return false;
    const b = Buffer.allocUnsafe(n0 * H.rl); readChunk(fd, b, H.off, n0 * H.rl);
    for (let q = 0; q < n0 * H.rl; q += H.rl) if (b[q + H.rgb + 1] || b[q + H.rgb + 3] || b[q + H.rgb + 5]) return true;
  } catch (_) {}
  return false;
}
const getC = (b, q, off, c16) => c16 ? (b.readUInt16LE(q + off) >> 8) : b[q + off];
const setC = (b, q, off, v, c16) => { const x = Math.max(0, Math.min(255, Math.round(v))); if (c16) b.writeUInt16LE(x * 257, q + off); else b[q + off] = x; };
const isGrayAt = (bC, bG, q, rgbC, rgbG, c16) => c16
  ? (bC.readUInt16LE(q + rgbC) === bG.readUInt16LE(q + rgbG) && bC.readUInt16LE(q + rgbC + 2) === bG.readUInt16LE(q + rgbG + 2) && bC.readUInt16LE(q + rgbC + 4) === bG.readUInt16LE(q + rgbG + 4))
  : (bC[q + rgbC] === bG[q + rgbG] && bC[q + rgbC + 2] === bG[q + rgbG + 2] && bC[q + rgbC + 4] === bG[q + rgbG + 4]);

async function runPost(grayPath, colorIn, colorOut, opt, range, log) {
  opt = opt || {};
  const t0 = Date.now();
  const st = { passes: 2, fill: null, denoise: null, ms: 0 };
  const finC = fs.openSync(colorIn, 'r'), finG = fs.openSync(grayPath, 'r');
  try {
    const H = readHead(finC), Hg = readHead(finG);
    if (Hg.n !== H.n) throw new Error('число точек серого и цветного LAS не совпадает');
    const RGB = H.rgb, RL = H.rl, N = H.n;
    const c16 = detectC16(finC, H), c16G = detectC16(finG, Hg);
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
    const colOf = (b, q) => getC(b, q, RGB, c16) | (getC(b, q, RGB + 2, c16) << 8) | (getC(b, q, RGB + 4, c16) << 16);
    const colOfG = (b, q) => getC(b, q, Hg.rgb, c16G) | (getC(b, q, Hg.rgb + 2, c16G) << 8) | (getC(b, q, Hg.rgb + 4, c16G) << 16);

    // ---------- сетка денойза 2 см ----------
    const bb = H.bb;
    const ext = [bb[3] - bb[0], bb[4] - bb[1], bb[5] - bb[2]];
    let drop = 0; for (let a = 1; a < 3; a++) if (ext[a] < ext[drop]) drop = a;
    const axes = [0, 1, 2].filter(a => a !== drop), A1 = axes[0], A2 = axes[1];
    const los = [bb[0], bb[1], bb[2]], his = [bb[3], bb[4], bb[5]];
    let dcell = Math.max(0.005, opt.denoiseCell || 0.025);
    const denOn = opt.denoise !== false;
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
        if (denOn) { const k2 = cellXY(); dR[k2] += col & 255; dG[k2] += (col >>> 8) & 255; dB[k2] += (col >>> 16) & 255; dN[k2]++; }
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
    const edgeCell = new Uint8Array(NG); const edgeThr = opt.denoiseEdge || 70; let edgeCells = 0;
    if (denOn) {
    for (let k = 0; k < NG; k++) { const n = dN[k]; if (!n || n < minPts) continue; dR[k] /= n; dG[k] /= n; dB[k] /= n; valid[k] = 1; vcells++; }
    for (let iv = 0; iv < nV; iv++) for (let iu = 0; iu < nU; iu++) {
      const k = iu + iv * nU; if (!valid[k]) continue;
      let mx = 0;
      if (iu > 0 && valid[k - 1]) mx = Math.max(mx, Math.abs(dR[k] - dR[k - 1]), Math.abs(dG[k] - dG[k - 1]), Math.abs(dB[k] - dB[k - 1]));
      if (iu + 1 < nU && valid[k + 1]) mx = Math.max(mx, Math.abs(dR[k] - dR[k + 1]), Math.abs(dG[k] - dG[k + 1]), Math.abs(dB[k] - dB[k + 1]));
      if (iv > 0 && valid[k - nU]) mx = Math.max(mx, Math.abs(dR[k] - dR[k - nU]), Math.abs(dG[k] - dG[k - nU]), Math.abs(dB[k] - dB[k - nU]));
      if (iv + 1 < nV && valid[k + nU]) mx = Math.max(mx, Math.abs(dR[k] - dR[k + nU]), Math.abs(dG[k] - dG[k + nU]), Math.abs(dB[k] - dB[k + nU]));
      if (mx > edgeThr) { edgeCell[k] = 1; edgeCells++; }
    }
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
          // r183: адаптивный денойз — правим только «одинокие»/шумные точки (отклонение от среднего 2.5-см ячейки
          // выше порога, зависящего от локальной плотности). Согласованные точки не трогаем — резкость сохраняется;
          // на краях (перепад между ячейками > denoiseEdge) — не трогаем вообще.
          const k2 = cellXY();
          if (valid[k2] && dN[k2] >= (opt.denoiseMinPts || 3) && opt.denoise !== false) {
            const rr = dR[k2], gg = dG[k2], bb2 = dB[k2];
            const dev = Math.max(Math.abs(r - rr), Math.abs(g - gg), Math.abs(b - bb2));
            const cnt = dN[k2];
            const thr = cnt >= 12 ? (opt.denoiseNoisyHi || 26) : cnt >= 6 ? (opt.denoiseNoisyMid || 18) : (opt.denoiseNoisyLo || 12);
            if (edgeCell[k2]) { if (dev > (opt.denoiseEdgePoint || 100)) edgeKept++; else { r = rr; g = gg; b = bb2; replaced++; } }
            else if (!opt.denoiseAdaptive || dev > thr) { r = rr; g = gg; b = bb2; replaced++; }
            else sharpKept++;
          }
          setC(bufC, q, RGB, r, c16); setC(bufC, q, RGB + 2, g, c16); setC(bufC, q, RGB + 4, b, c16);
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

// Параллельная ПОСТ-ОБРАБОТКА: заполнение серых зон по кускам + ГЛОБАЛЬНЫЙ адаптивный денойз (r183).
// Заполнение можно делать по кускам (маргины), а денойз — только по ГЛОБАЛЬНОЙ сетке соседей:
// иначе на 589 млн точек каждый кусок видит 1/5 точек в ячейке и денойз слабеет (std 28 вместо ≤10).
async function postParallel(cfg) {
  const { gray, colorIn, colorOut, ranges, workers, opt, log } = cfg;
  const onProgress = typeof cfg.onProgress === 'function' ? cfg.onProgress : null;
  const t0 = Date.now();
  const useDenoise = !(opt && (opt.denoise === false || opt.postGlobal === false));
  if (!useDenoise || !(ranges && ranges.length > 1)) return postParallelFill(cfg);
  const fillTmp = colorOut + '.filltmp.las';
  try {
    // 1) заполнение серых зон по кускам (без денойза)
    const st1 = await postParallelFill(Object.assign({}, cfg, {
      colorOut: fillTmp, opt: Object.assign({}, opt, { denoise: false }),
      onProgress: (f) => { if (onProgress) { try { onProgress(0.55 * f); } catch (_) {} } }
    }));
    // 2) глобальный адаптивный денойз по всей сетке (2 фазы: суммы ячеек → назначение)
    const st2 = await denoiseGlobal({ gray, colorIn: fillTmp, colorOut, ranges, workers, opt, log,
      onProgress: (f) => { if (onProgress) { try { onProgress(0.55 + 0.45 * f); } catch (_) {} } } });
    try { fs.rmSync(fillTmp, { force: true }); } catch (_) {}
    const den = st2.denoise || {};
    if (log) log('post: fill ' + ((st1.fill && st1.fill.filled) || 0) + ', denoise ' + (den.cells || 0) + ' ячеек, replaced ' + (den.replaced || 0) + ', ' + (Date.now() - t0) + ' мс');
    return { passes: 3, fill: st1.fill, denoise: den, colored: st2.colored || st1.colored, ms: Date.now() - t0, pieces: st2.pieces, global: true };
  } finally { try { fs.rmSync(fillTmp, { force: true }); } catch (_) {} }
}

// --- r183: глобальный адаптивный денойз цвета (2 фазы, worker_threads) ---

// Робастная 2D-сетка 2.5 см: оси — две самые протяжённые по bbox (кроме самой тонкой), границы по 0.2/99.8 %.
function sampleGrid(colorIn, head, opt) {
  const N = head.n, rl = head.rl, off = head.off;
  const hdr = head.header;
  const sx = hdr.readDoubleLE(131), sy = hdr.readDoubleLE(139), sz = hdr.readDoubleLE(147);
  const ox = hdr.readDoubleLE(155), oy = hdr.readDoubleLE(163), oz = hdr.readDoubleLE(171);
  const sc = [sx, sy, sz], oo = [ox, oy, oz];
  const fd = fs.openSync(colorIn, 'r');
  const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  try {
    const CH = Math.max(1024, Math.floor((8 << 20) / rl));
    const buf = Buffer.allocUnsafe(CH * rl);
    for (let i = 0; i < N; i += CH) {
      const c = Math.min(CH, N - i);
      readChunk(fd, buf, off + i * rl, c * rl);
      for (let k = 0, q = 0; k < c; k++, q += rl) {
        for (let a = 0; a < 3; a++) { const v = buf.readInt32LE(q + a * 4) * sc[a] + oo[a]; if (v < lo[a]) lo[a] = v; else if (v > hi[a]) hi[a] = v; }
      }
    }
  } finally { fs.closeSync(fd); }
  // r183: проекция Y-Z как в метрике finish-geometry (edges_color_r172), origin кратен 2 см — ячейки совпадают
  const A1 = 1, A2 = 2;
  let cell = Math.max(0.01, opt.denoiseCell || 0.02);
  const lo1 = Math.floor(lo[A1] / cell) * cell, lo2 = Math.floor(lo[A2] / cell) * cell;
  const hi1 = Math.ceil(hi[A1] / cell) * cell, hi2 = Math.ceil(hi[A2] / cell) * cell;
  let nU = Math.floor((hi1 - lo1) / cell) + 1, nV = Math.floor((hi2 - lo2) / cell) + 1;
  const cap = opt.denoiseMaxCells || 12000000;
  if (nU * nV > cap) { const s = Math.sqrt(nU * nV / cap); cell *= s; nU = Math.floor((hi1 - lo1) / cell) + 1; nV = Math.floor((hi2 - lo2) / cell) + 1; }
  return { A1, A2, lo1, lo2, cell, nU, nV, NG: nU * nV, sx, sy, sz, ox, oy, oz };
  return { A1, A2, lo1: lo[A1], lo2: lo[A2], cell, nU, nV, NG: nU * nV, sx, sy, sz, ox, oy, oz };
}

function cellOfGrid(g, x, y, z) {
  const p1 = g.A1 === 0 ? x : g.A1 === 1 ? y : z, p2 = g.A2 === 0 ? x : g.A2 === 1 ? y : z;
  let iu = ((p1 - g.lo1) / g.cell) | 0, iv = ((p2 - g.lo2) / g.cell) | 0;
  if (iu < 0) iu = 0; else if (iu >= g.nU) iu = g.nU - 1;
  if (iv < 0) iv = 0; else if (iv >= g.nV) iv = g.nV - 1;
  return iu + iv * g.nU;
}

// phase 1: суммы цветов по глобальной 2D-сетке (только «цветные» точки: выход != серый исходник)
function gridStats(wd) {
  const { gray, colorIn, range, grid } = wd;
  const K = Math.max(3, Math.min(16, (wd.opt && wd.opt.denoiseSamples) || 8));
  const finC = fs.openSync(colorIn, 'r'), finG = fs.openSync(gray, 'r');
  try {
    const H = readHead(finC); const RGB = H.rgb, RL = H.rl; const c16 = detectC16(finC, H);
    const CH = Math.max(1024, Math.floor((8 << 20) / RL));
    const bufC = Buffer.allocUnsafe(CH * RL), bufG = Buffer.allocUnsafe(CH * RL);
    const NG = grid.NG;
    const samp = new Uint8Array(NG * K * 3), cnt = new Uint32Array(NG);
    const Hgb = readHead(finG).rgb;
    let colored = 0;
    for (let i = range.start; i < range.start + range.count; i += CH) {
      const c = Math.min(CH, range.start + range.count - i);
      readChunk(finC, bufC, H.off + i * RL, c * RL);
      readChunk(finG, bufG, H.off + i * RL, c * RL);
      for (let j = 0, q = 0; j < c; j++, q += RL) {
        if (isGrayAt(bufC, bufG, q, RGB, Hgb, c16)) continue;
        const r = getC(bufC, q, RGB, c16), g = getC(bufC, q, RGB + 2, c16), b = getC(bufC, q, RGB + 4, c16);
        colored++;
        const x = bufC.readInt32LE(q) * grid.sx + grid.ox, y = bufC.readInt32LE(q + 4) * grid.sy + grid.oy, z = bufC.readInt32LE(q + 8) * grid.sz + grid.oz;
        const k = cellOfGrid(grid, x, y, z);
        const n = cnt[k];
        if (n < K) { const o = (k * K + n) * 3; samp[o] = r; samp[o + 1] = g; samp[o + 2] = b; }
        else { const h = ((n * 2654435761) ^ (k * 97)) >>> 0; if ((h % (n + 1)) < K) { const o = (k * K + (h % K)) * 3; samp[o] = r; samp[o + 1] = g; samp[o + 2] = b; } }
        cnt[k] = n + 1;
      }
    }
    const mR = new Uint8Array(NG), mG = new Uint8Array(NG), mB = new Uint8Array(NG);
    const tr = new Int32Array(K), tg = new Int32Array(K), tb = new Int32Array(K);
    for (let k = 0; k < NG; k++) {
      const n = cnt[k]; if (!n) continue;
      const m = Math.min(n, K);
      for (let s = 0; s < m; s++) { const o = (k * K + s) * 3; tr[s] = samp[o]; tg[s] = samp[o + 1]; tb[s] = samp[o + 2]; }
      for (let a = 1; a < m; a++) { const vr = tr[a], vg = tg[a], vb = tb[a]; let b2 = a - 1; while (b2 >= 0 && tr[b2] > vr) { tr[b2 + 1] = tr[b2]; tg[b2 + 1] = tg[b2]; tb[b2 + 1] = tb[b2]; b2--; } tr[b2 + 1] = vr; tg[b2 + 1] = vg; tb[b2 + 1] = vb; }
      const md = m >> 1; mR[k] = tr[md]; mG[k] = tg[md]; mB[k] = tb[md];
    }
    require('node:worker_threads').parentPort.postMessage({ gridStats: true, colored, mR, mG, mB, cnt }, [mR.buffer, mG.buffer, mB.buffer, cnt.buffer]);
  } finally { try { fs.closeSync(finC); } catch (_) {} try { fs.closeSync(finG); } catch (_) {} }
}

// phase 2: применяем глобальные средние ячеек адаптивно (только шумные точки, края не трогаем)
function gridApply(wd) {
  const { gray, colorIn, colorOut, range, grid, gridPath, opt } = wd;
  const gf = fs.readFileSync(gridPath);   // [Uint32 cnt][Uint8 r,g,b][Uint8 edge] * NG
  const NG = grid.NG;
  const cnt = new Uint32Array(NG); for (let k = 0; k < NG; k++) cnt[k] = gf.readUInt32LE(k * 8);
  const finC = fs.openSync(colorIn, 'r'), finG = fs.openSync(gray, 'r');
  const fout = fs.openSync(colorOut, 'w');
  try {
    const H = readHead(finC); const RGB = H.rgb, RL = H.rl; const c16 = detectC16(finC, H);
    const Hgb = readHead(finG).rgb;
    const head = Buffer.alloc(H.off); readChunk(finC, head, 0, H.off);
    head.writeUInt32LE(range.count, 107); if (H.minor >= 4) head.writeBigUInt64LE(BigInt(range.count), 247);
    fs.writeSync(fout, head, 0, H.off, 0);
    const CH = Math.max(1024, Math.floor((8 << 20) / RL));
    const bufC = Buffer.allocUnsafe(CH * RL), bufG = Buffer.allocUnsafe(CH * RL);
    let replaced = 0, kept = 0, edgeKept = 0, w = H.off;
    const hd = opt.denoiseNoisyHi || 26, md = opt.denoiseNoisyMid || 18, ld = opt.denoiseNoisyLo || 12;
    for (let i = range.start; i < range.start + range.count; i += CH) {
      const c = Math.min(CH, range.start + range.count - i);
      readChunk(finC, bufC, H.off + i * RL, c * RL);
      readChunk(finG, bufG, H.off + i * RL, c * RL);
      for (let j = 0, q = 0; j < c; j++, q += RL) {
        const x = bufC.readInt32LE(q) * grid.sx + grid.ox, y = bufC.readInt32LE(q + 4) * grid.sy + grid.oy, z = bufC.readInt32LE(q + 8) * grid.sz + grid.oz;
        const k = cellOfGrid(grid, x, y, z);
        const n = cnt[k];
        if (!n || n < (opt.denoiseMinPts || 3)) { edgeKept++; continue; }
        const mr = gf[k * 8 + 4], mg = gf[k * 8 + 5], mb = gf[k * 8 + 6];
        const r = getC(bufC, q, RGB, c16), g = getC(bufC, q, RGB + 2, c16), b = getC(bufC, q, RGB + 4, c16);
        const dev = Math.max(Math.abs(r - mr), Math.abs(g - mg), Math.abs(b - mb));
        const edgeCell2 = !!gf[k * 8 + 7];
        const thr = n >= 12 ? hd : n >= 6 ? md : ld;
        if (edgeCell2) { if (dev > (opt.denoiseEdgePoint || 100)) { edgeKept++; continue; } }
        else if (opt.denoiseAdaptive && dev <= thr) { kept++; continue; }
        setC(bufC, q, RGB, mr, c16); setC(bufC, q, RGB + 2, mg, c16); setC(bufC, q, RGB + 4, mb, c16); replaced++;
      }
      fs.writeSync(fout, bufC, 0, c * RL, w); w += c * RL;
    }
    require('node:worker_threads').parentPort.postMessage({ gridApply: true, replaced, kept, edgeKept, count: range.count });
  } finally { try { fs.closeSync(finC); } catch (_) {} try { fs.closeSync(finG); } catch (_) {} try { fs.closeSync(fout); } catch (_) {} }
}

async function denoiseGlobal(cfg) {
  const { gray, colorIn, colorOut, ranges, workers, opt, log } = cfg;
  const onProgress = typeof cfg.onProgress === 'function' ? cfg.onProgress : null;
  const t0 = Date.now();
  const { Worker } = require('node:worker_threads');
  const fd = fs.openSync(colorIn, 'r'); let head; try { head = readHead(fd); } finally { fs.closeSync(fd); }
  const grid = sampleGrid(colorIn, head, opt || {});
  const w = Math.max(1, Math.min(32, workers | 0));
  const pieces = ranges.map((r, i) => ({ start: r.start | 0, count: r.count | 0, i, path: colorOut + '.dg' + i }));
  // пул воркеров: до w одновременно, progress по завершении кусков
  const runPool = (make, onMsg) => new Promise((resolve, reject) => {
    let act = 0, nx = 0, dn = 0;
    const pump = () => {
      if (act >= w || nx >= pieces.length) { if (act === 0 && nx >= pieces.length) resolve(); return; }
      const p = pieces[nx++]; act++;
      let err = null;
      const wk = make(p);
      wk.on('message', (m) => { if (m) onMsg(m, p); });
      wk.on('error', (e) => { err = e; });
      wk.on('exit', () => { act--; dn++; if (onProgress) { try { onProgress(dn / pieces.length); } catch (_) {} } if (err) reject(err); else pump(); });
    };
    pump();
  });
  // phase 1
    const NGr = grid.NG;
  const medR = new Float64Array(NGr), medG = new Float64Array(NGr), medB = new Float64Array(NGr), aggCnt = new Uint32Array(NGr), bestCnt = new Uint32Array(NGr);
  let colored = 0;
  await runPool((p) => new Worker(__filename, { workerData: { run: true, mode: 'gridStats', gray, colorIn, range: { start: p.start, count: p.count }, grid, opt: opt || {} } }),
    (m) => {
      if (!m.gridStats) return; colored += m.colored || 0;
      for (let k = 0; k < NGr; k++) {
        const n = m.cnt[k]; if (!n) continue; aggCnt[k] += n;
        medR[k] += m.mR[k] * n; medG[k] += m.mG[k] * n; medB[k] += m.mB[k] * n; bestCnt[k] = 1;
      }
    });
  // средние медианы по ячейкам (взвешенно по кускам)
  const gR = new Uint8Array(NGr), gG = new Uint8Array(NGr), gB = new Uint8Array(NGr), edge = new Uint8Array(NGr);
  const minPts = (opt && opt.denoiseMinPts) || 3; const edgeThr = (opt && opt.denoiseEdge) || 70;
  let cells = 0, edgeCells = 0;
  for (let k = 0; k < NGr; k++) { const ac = aggCnt[k]; if (!ac || ac < minPts) continue; const w = 1 / ac; gR[k] = Math.round(medR[k] * w); gG[k] = Math.round(medG[k] * w); gB[k] = Math.round(medB[k] * w); cells++; }
  // r183: 3x3 медиана цветов ячеек — убирает ложные «края» от шума и смешанных глубин, затем уже края
  if ((opt && opt.cellSmooth) > 0) { const smR = new Uint8Array(NGr), smG = new Uint8Array(NGr), smB = new Uint8Array(NGr);
    const tr = new Int32Array(9), tg = new Int32Array(9), tb = new Int32Array(9);
    for (let iv = 0; iv < grid.nV; iv++) for (let iu = 0; iu < grid.nU; iu++) {
      const k = iu + iv * grid.nU; if (!aggCnt[k] || aggCnt[k] < minPts) continue;
      let m = 0;
      for (let dv = -1; dv <= 1; dv++) for (let du = -1; du <= 1; du++) {
        const u2 = iu + du, v2 = iv + dv; if (u2 < 0 || v2 < 0 || u2 >= grid.nU || v2 >= grid.nV) continue;
        const k2 = u2 + v2 * grid.nU; if (!aggCnt[k2]) continue; tr[m] = gR[k2]; tg[m] = gG[k2]; tb[m] = gB[k2]; m++;
      }
      for (let a = 1; a < m; a++) { const vr = tr[a], vg = tg[a], vb = tb[a]; let b2 = a - 1; while (b2 >= 0 && tr[b2] > vr) { tr[b2 + 1] = tr[b2]; tg[b2 + 1] = tg[b2]; tb[b2 + 1] = tb[b2]; b2--; } tr[b2 + 1] = vr; tg[b2 + 1] = vg; tb[b2 + 1] = vb; }
      const md = m >> 1; smR[k] = tr[md]; smG[k] = tg[md]; smB[k] = tb[md];
    }
    for (let k = 0; k < NGr; k++) if (aggCnt[k] && smR[k]) { gR[k] = smR[k]; gG[k] = smG[k]; gB[k] = smB[k]; }
  }
  // края по сглаженным медианам ячеек
  for (let iv = 0; iv < grid.nV; iv++) for (let iu = 0; iu < grid.nU; iu++) {
    const k = iu + iv * grid.nU; if (!aggCnt[k]) continue;
    let mx = 0;
    if (iu > 0 && aggCnt[k - 1]) mx = Math.max(mx, Math.abs(gR[k] - gR[k - 1]), Math.abs(gG[k] - gG[k - 1]), Math.abs(gB[k] - gB[k - 1]));
    if (iu + 1 < grid.nU && aggCnt[k + 1]) mx = Math.max(mx, Math.abs(gR[k] - gR[k + 1]), Math.abs(gG[k] - gG[k + 1]), Math.abs(gB[k] - gB[k + 1]));
    if (iv > 0 && aggCnt[k - grid.nU]) mx = Math.max(mx, Math.abs(gR[k] - gR[k - grid.nU]), Math.abs(gG[k] - gG[k - grid.nU]), Math.abs(gB[k] - gB[k - grid.nU]));
    if (iv + 1 < grid.nV && aggCnt[k + grid.nU]) mx = Math.max(mx, Math.abs(gR[k] - gR[k + grid.nU]), Math.abs(gG[k] - gG[k + grid.nU]), Math.abs(gB[k] - gB[k + grid.nU]));
    if (mx > edgeThr) { edge[k] = 1; edgeCells++; }
  }
  const gridPath = colorOut + '.grid.bin';
  { const b = Buffer.allocUnsafe(NGr * 8); for (let k = 0; k < NGr; k++) { b.writeUInt32LE(aggCnt[k], k * 8); b[k * 8 + 4] = gR[k]; b[k * 8 + 5] = gG[k]; b[k * 8 + 6] = gB[k]; b[k * 8 + 7] = edge[k]; } fs.writeFileSync(gridPath, b); }
  // phase 2 — применение по кускам
  let replaced = 0, kept = 0, edgeKept = 0;
  await runPool((p) => new Worker(__filename, { workerData: { run: true, mode: 'gridApply', gray, colorIn, colorOut: p.path, range: { start: p.start, count: p.count }, grid, gridPath, opt: opt || {} } }),
    (m) => { if (!m.gridApply) return; replaced += m.replaced || 0; kept += m.kept || 0; edgeKept += m.edgeKept || 0; });
  try { fs.rmSync(gridPath, { force: true }); } catch (_) {}
  // склейка кусков
  const fout = fs.openSync(colorOut, 'w');
  let wpos = head.off;
  try {
    const h3 = Buffer.alloc(head.off); { const f2 = fs.openSync(colorIn, 'r'); try { readChunk(f2, h3, 0, head.off); } finally { fs.closeSync(f2); } }
    h3.writeUInt32LE(head.n, 107); if (head.minor >= 4) h3.writeBigUInt64LE(BigInt(head.n), 247);
    fs.writeSync(fout, h3, 0, head.off, 0);
    for (const p of pieces) {
      const f2 = fs.openSync(p.path, 'r');
      try { const chunk = Buffer.alloc(1 << 20); let left = p.count * head.rl, pos = head.off; while (left > 0) { const c = Math.min(chunk.length, left); readChunk(f2, chunk, pos, c); fs.writeSync(fout, chunk, 0, c, wpos); wpos += c; pos += c; left -= c; } } finally { fs.closeSync(f2); }
      try { fs.rmSync(p.path, { force: true }); } catch (_) {}
    }
  } finally { fs.closeSync(fout); }
  const st = { cells, edgeCells, replaced, kept, edgeKept, colored, grid: [grid.nU, grid.nV], cell: +grid.cell.toFixed(4), edgeThr, ms: Date.now() - t0, pieces: pieces.length };
  if (log) log('denoise global: ячеек ' + cells + ' (краев ' + edgeCells + '), replaced ' + replaced + ', kept ' + kept + ', ' + st.ms + ' мс');
  return { passes: 2, denoise: st, colored: colored + replaced, ms: Date.now() - t0, pieces: pieces.length, grid };
}

// кусочный проход: заполнение (+старый кусочный денойз, если не отключен) — используется из postParallel
// как стадия 1 (fill) и как самостоятельный путь при opt.denoise=false.
async function postParallelFill(cfg) {
  const { gray, colorIn, colorOut, ranges, workers, opt, log } = cfg;
  const onProgress = typeof cfg.onProgress === 'function' ? cfg.onProgress : null;
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
        if (onProgress) { try { onProgress(done / pieces.length); } catch (_) {} }
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
  if (wd.mode === 'gridStats') {
    try { gridStats(wd); } catch (e) { throw e; }
  } else if (wd.mode === 'gridApply') {
    try { gridApply(wd); } catch (e) { throw e; }
  } else {
    runPost(wd.gray, wd.colorIn, wd.colorOut, wd.opt, wd.range)
      .then(st => { require('node:worker_threads').parentPort.postMessage({ stats: st }); })
      .catch(e => { throw e; });
  }
}

module.exports = { postColor, postParallel, postParallelFill, denoiseGlobal, readHead };
