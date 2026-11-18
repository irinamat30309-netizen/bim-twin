'use strict';
/*
 * speckle-clean.js — r174: удаление спекл-шума (одиноких/изолированных точек) из готового LAS.
 *
 * Метод: радиусный outlier removal по сетке (radius outlier removal, аналог CloudCompare SOR по локальной
 * плотности): точки считаются в вокселях cell; для каждой точки суммируются счётчики 27 соседних вокселей;
 * если соседей меньше minNeighbors — точка удаляется. Две потоковые проходы: подсчёт вокселей → фильтрация
 * и запись. Память — только хеш занятых вокселей, поэтому работает на облаках в сотни миллионов точек.
 *
 * opt: { cell: 0.1, minNeighbors: 4 }
 * Возвращает { points, removed, removedFrac, cell, minNeighbors, ms, maxRssMB }.
 */
const fs = require('node:fs');
const R = require('./scan-refine-core');

const DEF = { cell: 0.1, minNeighbors: 4 };
const K = 4096, KK = K * K;

function hashNew(cap) { return { cap, keys: new Float64Array(cap).fill(-1), cnt: new Int32Array(cap), n: 0 }; }
function hashGrow(h) {
  const n = hashNew(h.cap * 2);
  for (let i = 0; i < h.cap; i++) if (h.keys[i] >= 0) hashAddKey(n, h.keys[i], h.cnt[i]);
  return n;
}
function hashSlot(h, key) {
  let i = (key * 2654435761) >>> 0 & (h.cap - 1);
  for (let it = 0; it < h.cap; it++) {
    const k = h.keys[i];
    if (k === -1 || k === key) return i;
    i = (i + 1) & (h.cap - 1);
  }
  return -1;
}
function hashAddKey(h, key, count) {
  const i = hashSlot(h, key);
  if (h.keys[i] === -1) { h.keys[i] = key; h.cnt[i] = count; h.n++; } else h.cnt[i] += count;
  return h;
}
function hashAdd(h, key) {
  if ((h.n + 1) * 10 > h.cap * 7) h = hashGrow(h);
  const i = hashSlot(h, key);
  if (h.keys[i] === -1) { h.keys[i] = key; h.cnt[i] = 1; h.n++; } else h.cnt[i]++;
  return h;
}
function hashGet(h, key) { const i = hashSlot(h, key); return h.keys[i] === key ? h.cnt[i] : 0; }

function cellKey(x, y, z, cell, ox, oy, oz) {
  const ix = Math.floor((x - ox) / cell), iy = Math.floor((y - oy) / cell), iz = Math.floor((z - oz) / cell);
  return ix + K * iy + KK * iz;
}

/** r174: радиусная чистка спекл-шума в LAS. */
function cleanLas(src, dst, opt, onProgress) {
  const o = Object.assign({}, DEF, opt || {});
  const prog = typeof onProgress === 'function' ? onProgress : () => {};
  const t0 = Date.now();
  const cell = o.cell > 0 ? o.cell : DEF.cell;
  const minN = Math.max(1, o.minNeighbors | 0 || DEF.minNeighbors);
  const fd = fs.openSync(src, 'r');
  let ofd = null, tmp = null;
  try {
    const H = R.readHeader(fd);
    const per = 1 << 18, buf = Buffer.allocUnsafe(per * H.rl);
    const readChunk = (i) => {
      const c = Math.min(per, H.n - i), bytes = c * H.rl; let got = 0;
      while (got < bytes) { const r = fs.readSync(fd, buf, got, bytes - got, H.off + i * H.rl + got); if (!r) break; got += r; }
      return got < bytes ? Math.min(c, Math.floor(got / H.rl)) : c;
    };
    // проход 1: счётчики вокселей
    let hs = hashNew(1 << 21);
    for (let i = 0; i < H.n; i += per) {
      const c = readChunk(i); if (!c) break;
      for (let q = 0, p = 0; q < c; q++, p += H.rl) {
        const x = buf.readInt32LE(p) * H.sx + H.ox, y = buf.readInt32LE(p + 4) * H.sy + H.oy, z = buf.readInt32LE(p + 8) * H.sz + H.oz;
        hs = hashAdd(hs, cellKey(x, y, z, cell, H.ox, H.oy, H.oz));
      }
      prog(0.05 + 0.45 * (i + c) / H.n, 'Спекл-чистка: подсчёт плотности…');
    }
    // проход 2: фильтрация и запись
    ofd = fs.openSync(dst, 'w+');
    const hb = Buffer.alloc(H.off); fs.readSync(fd, hb, 0, hb.length, 0);
    const OB = Buffer.allocUnsafe(8192 * H.rl);
    const bb = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity];
    let out = 0, wpos = H.off, on = 0;
    const flush = () => { if (on) { fs.writeSync(ofd, OB, 0, on, wpos); wpos += on; on = 0; } };
    for (let i = 0; i < H.n; i += per) {
      const c = readChunk(i); if (!c) break;
      for (let q = 0, p = 0; q < c; q++, p += H.rl) {
        const x = buf.readInt32LE(p) * H.sx + H.ox, y = buf.readInt32LE(p + 4) * H.sy + H.oy, z = buf.readInt32LE(p + 8) * H.sz + H.oz;
        const k0 = cellKey(x, y, z, cell, H.ox, H.oy, H.oz);
        let cnt = 0;
        for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) for (let dz = -1; dz <= 1; dz++) {
          cnt += hashGet(hs, k0 + dx + K * dy + KK * dz);
        }
        if (cnt < minN) continue;
        if (on + H.rl > OB.length) flush();
        buf.copy(OB, on, p, p + H.rl); on += H.rl; out++;
        if (x < bb[0]) bb[0] = x; if (y < bb[1]) bb[1] = y; if (z < bb[2]) bb[2] = z;
        if (x > bb[3]) bb[3] = x; if (y > bb[4]) bb[4] = y; if (z > bb[5]) bb[5] = z;
      }
      prog(0.5 + 0.5 * (i + c) / H.n, 'Спекл-чистка: фильтрация…');
    }
    flush();
    // обновить заголовок (n, bbox)
    const hdr = Buffer.from(hb.subarray(0, Math.min(hb.length, 375)));
    hdr.writeUInt32LE(out, 107);
    for (let r = 0; r < 5; r++) hdr.writeUInt32LE(r === 0 ? out : 0, 111 + r * 4);
    hdr.writeDoubleLE(bb[3], 179); hdr.writeDoubleLE(bb[0], 187); hdr.writeDoubleLE(bb[4], 195); hdr.writeDoubleLE(bb[1], 203); hdr.writeDoubleLE(bb[5], 211); hdr.writeDoubleLE(bb[2], 219);
    fs.writeSync(ofd, hdr, 0, Math.min(227, hdr.length), 0);
    return { ok: true, points: out, removed: H.n - out, removedFrac: H.n ? (H.n - out) / H.n : 0,
      cell, minNeighbors: minN, ms: Date.now() - t0, maxRssMB: Math.round(process.memoryUsage().rss / 1048576), vx: hs.n };
  } finally {
    if (ofd !== null) { try { fs.closeSync(ofd); } catch (_) {} }
    fs.closeSync(fd);
  }
}

module.exports = { cleanLas, cellKey, DEF };
