/*
 * dynamic-voxels.js — разметка точек по списку «движущихся» вокселей (результат dynamic-clean-core.js из фонового потока).
 * Воксели заданы в координатах исходного файла; точки окна переводятся в них через srcXform облака (ось Z-up/Y-up и смещение).
 * Порядок точек не важен — работает и для облака, прочитанного частями, и после правок.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.DynVoxels = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';
  // keys — линейные индексы вокселей ix + nx·(iy + ny·iz); блоки 4×4×4 в хеш-таблице, внутри блока — 64 бита
  function build(keys, grid) {
    const nx = grid.nx, ny = grid.ny, nz = grid.nz, bx = (nx + 3) >> 2, by = (ny + 3) >> 2;
    let cap = 1024; while (cap < keys.length * 2) cap <<= 1;
    const K = new Float64Array(cap).fill(-1), lo = new Uint32Array(cap), hi = new Uint32Array(cap), mask = cap - 1;
    const slot = (bk) => { let h = (Math.imul((bk % 4294967296) >>> 0, 2654435761) ^ Math.floor(bk / 4294967296)) & mask; while (K[h] !== -1 && K[h] !== bk) h = (h + 1) & mask; return h; };
    for (let i = 0; i < keys.length; i++) {
      const k = keys[i], ix = k % nx, r = (k - ix) / nx, iy = r % ny, iz = (r - iy) / ny;
      const bk = (iz >> 2) * by * bx + (iy >> 2) * bx + (ix >> 2), h = slot(bk), l = ((iz & 3) << 4) | ((iy & 3) << 2) | (ix & 3);
      K[h] = bk; if (l < 32) lo[h] |= (1 << l); else hi[h] |= (1 << (l - 32));
    }
    return { grid: { gx: +grid.gx, gy: +grid.gy, gz: +grid.gz, v: +grid.v, nx, ny, nz }, bx, by, K, lo, hi, mask, count: keys.length,
      has(sx, sy, sz) {
        const g = this.grid, iv = 1 / g.v, ix = Math.floor((sx - g.gx) * iv), iy = Math.floor((sy - g.gy) * iv), iz = Math.floor((sz - g.gz) * iv);
        if (ix < 0 || iy < 0 || iz < 0 || ix >= nx || iy >= ny || iz >= nz) return false;
        const bk = (iz >> 2) * by * bx + (iy >> 2) * bx + (ix >> 2); let h = (Math.imul((bk % 4294967296) >>> 0, 2654435761) ^ Math.floor(bk / 4294967296)) & mask;
        while (K[h] !== -1) { if (K[h] === bk) { const l = ((iz & 3) << 4) | ((iy & 3) << 2) | (ix & 3); return l < 32 ? !!(lo[h] & (1 << l)) : !!(hi[h] & (1 << (l - 32))); } h = (h + 1) & mask; }
        return false;
      } };
  }
  // Перевод точки окна в координаты файла: { zup, t } как в big-cloud.js (xfOf)
  function xfOf(srcXform) {
    const x = srcXform; return (x && x.t && x.t.length >= 3) ? { zup: x.axis === 'zup', t: [Number(x.t[0]), Number(x.t[1]), Number(x.t[2])] } : null;
  }
  /** Отметить точки P[from..to) (Float32 xyz окна), попавшие в движущиеся воксели: cb(i) для каждой; возвращает их число. */
  function classify(M, P, from, to, xf, cb) {
    let c = 0; const t = xf ? xf.t : [0, 0, 0], zup = !!(xf && xf.zup);
    for (let i = from, j = from * 3; i < to; i++, j += 3) {
      const x = P[j], y = P[j + 1], z = P[j + 2];
      const ok = zup ? M.has(x + t[0], -z + t[1], y + t[2]) : M.has(x + t[0], y + t[1], z + t[2]);
      if (ok) { c++; cb(i); }
    }
    return c;
  }
  return { build: build, classify: classify, xfOf: xfOf };
});
