'use strict';
/**
 * Ревизия r109 (фаза 2, B4): выбрать кроп 20×20×20 м из большой карты (map.las, 175 млн / 5.7 ГБ),
 * не загружая её в память: потоковый проход по LAS + сетка 1 м по X/Y с min/max Z.
 * Критерий выбора — максимум точек в вертикальных структурах (перепад Z в клетке ≥ 6 м),
 * т.е. кроп попадает на фасад/стену, а не на плоский пол/дорогу.
 *
 *   node tools/scan2bim-py/las-pick-crop.js map.las --size=20 --max-z=19.12 [--json=out.json]
 *
 * Возврат JSON: { box:[x0,y0,z0,x1,y1,z1], points_est, cells, height }
 */
const fs = require('node:fs');
const path = require('node:path');

function readHeader(fd) {
  const h = Buffer.alloc(375);
  fs.readSync(fd, h, 0, 375, 0);
  if (h.toString('latin1', 0, 4) !== 'LASF') throw new Error('файл не LAS');
  const minor = h[25], off = h.readUInt32LE(96), fmt = h[104] & 0x3f, rl = h.readUInt16LE(105);
  if (h[104] & 0x80) throw new Error('сжатый LAZ не поддерживается');
  let n = h.readUInt32LE(107);
  if (minor >= 4) { const n2 = Number(h.readBigUInt64LE(247)); if (n2 > 0) n = n2; }
  return {
    minor, off, fmt, rl, n,
    sx: h.readDoubleLE(131), sy: h.readDoubleLE(139), sz: h.readDoubleLE(147),
    ox: h.readDoubleLE(155), oy: h.readDoubleLE(163), oz: h.readDoubleLE(171)
  };
}

function main(argv) {
  const src = argv[0];
  if (!src) { console.error('нужно: node tools/scan2bim-py/las-pick-crop.js map.las [--size=20] [--max-z=..]'); process.exit(2); }
  const arg = (k) => { const i = argv.findIndex(a => a === '--' + k || a.startsWith('--' + k + '=')); return i >= 0 ? (argv[i].includes('=') ? argv[i].slice(argv[i].indexOf('=') + 1) : argv[i + 1]) : null; };
  const size = arg('size') ? Number(arg('size')) : 20;
  const maxZArg = arg('max-z') ? Number(arg('max-z')) : null;

  const fd = fs.openSync(src, 'r');
  try {
    const H = readHeader(fd);
    // границы по заголовку нужны лишь для размера сетки — берём из сканирования
    const CELLXY = 1.0;
    const recs = new Float64Array(1 << 20);   // X,Y,Z в абсолютных координатах
    let nread = 0;
    let mnx = Infinity, mny = Infinity, mnz = Infinity, mxx = -Infinity, mxy = -Infinity, mxz = -Infinity;
    const per = 1 << 18;
    const buf = Buffer.allocUnsafe(per * H.rl);
    const tmpX = new Float64Array(per), tmpY = new Float64Array(per), tmpZ = new Float64Array(per);
    for (let i = 0; i < H.n; i += per) {
      const c = Math.min(per, H.n - i), bytes = c * H.rl;
      let got = 0;
      while (got < bytes) { const r = fs.readSync(fd, buf, got, bytes - got, H.off + i * H.rl + got); if (!r) throw new Error('файл обрезан'); got += r; }
      for (let q = 0, p = 0; q < c; q++, p += H.rl) {
        const x = buf.readInt32LE(p) * H.sx + H.ox;
        const y = buf.readInt32LE(p + 4) * H.sy + H.oy;
        const z = buf.readInt32LE(p + 8) * H.sz + H.oz;
        if (nread >= recs.length) { /* дальше только габариты — точки не нужны */ }
        if (x < mnx) mnx = x; if (y < mny) mny = y; if (z < mnz) mnz = z;
        if (x > mxx) mxx = x; if (y > mxy) mxy = y; if (z > mxz) mxz = z;
        nread++;
      }
    }
    // второй потоковый проход уже с известной сеткой: считаем точки/высоту по клеткам
    const nx = Math.floor((mxx - mnx) / CELLXY) + 2, ny = Math.floor((mxy - mny) / CELLXY) + 2;
    const cnt = new Float64Array(nx * ny), zmin = new Float64Array(nx * ny).fill(Infinity), zmax = new Float64Array(nx * ny).fill(-Infinity);
    const n2 = H.n;
    for (let i = 0; i < n2; i += per) {
      const c = Math.min(per, n2 - i), bytes = c * H.rl;
      let got = 0;
      while (got < bytes) { const r = fs.readSync(fd, buf, got, bytes - got, H.off + i * H.rl + got); if (!r) throw new Error('файл обрезан'); got += r; }
      for (let q = 0, p = 0; q < c; q++, p += H.rl) {
        const x = buf.readInt32LE(p) * H.sx + H.ox;
        const y = buf.readInt32LE(p + 4) * H.sy + H.oy;
        const z = buf.readInt32LE(p + 8) * H.sz + H.oz;
        const ix = Math.floor((x - mnx) / CELLXY), iy = Math.floor((y - mny) / CELLXY);
        if (ix < 0 || iy < 0 || ix >= nx || iy >= ny) continue;
        const k = iy * nx + ix;
        cnt[k]++;
        if (z < zmin[k]) zmin[k] = z;
        if (z > zmax[k]) zmax[k] = z;
      }
      process.stderr.write('.');
    }
    process.stderr.write('\n');
    // интегральные суммы для быстрой оценки 20×20-рамок: точки и «вертикальные» точки
    const W = [];
    for (let iy = 0; iy < ny; iy++) {
      W[iy] = new Float64Array(nx + 1);
      for (let ix = 0; ix < nx; ix++) {
        const k = iy * nx + ix;
        const vert = (cnt[k] > 0 && (zmax[k] - zmin[k]) >= 6.0) ? cnt[k] : 0;
        W[iy][ix + 1] = W[iy][ix] + vert;
      }
    }
    const cells = Math.round(size / CELLXY);
    let best = null;
    for (let iy = 0; iy + cells <= ny; iy++) {
      for (let ix = 0; ix + cells <= nx; ix++) {
        let s = 0;
        for (let q = iy; q < iy + cells; q++) s += W[q][ix + cells] - W[q][ix];
        if (!best || s > best.s) best = { s, ix, iy };
      }
    }
    if (!best) throw new Error('не нашёл ни одной 20×20-рамки');
    const x0 = mnx + best.ix * CELLXY, y0 = mny + best.iy * CELLXY;
    const x1 = x0 + size, y1 = y0 + size;
    // высота: от земли в рамке до +size; если в рамке есть точки — низ = minZ рамки
    let z0 = null, z1 = null, boxPts = 0;
    const ix0 = best.ix, iy0 = best.iy, ix1 = Math.min(nx, ix0 + cells), iy1 = Math.min(ny, iy0 + cells);
    let zlo = Infinity, zhi = -Infinity;
    for (let iy = iy0; iy < iy1; iy++) for (let ix = ix0; ix < ix1; ix++) {
      const k = iy * nx + ix;
      boxPts += cnt[k];
      if (cnt[k] > 0) { if (zmin[k] < zlo) zlo = zmin[k]; if (zmax[k] > zhi) zhi = zmax[k]; }
    }
    z0 = Number.isFinite(zlo) ? zlo : mnz;
    if (maxZArg !== null && z0 + size > maxZArg) z0 = maxZArg - size;
    z1 = z0 + size;
    const box = [+x0.toFixed(3), +y0.toFixed(3), +z0.toFixed(3), +x1.toFixed(3), +y1.toFixed(3), +z1.toFixed(3)];
    const info = {
      ok: true, src: path.basename(src), points_total: H.n, box, points_est: boxPts,
      vertical_points: Math.round(best.s), cells, map_bbox: [mnx, mny, mnz, mxx, mxy, mxz].map(v => +v.toFixed(2)),
      z_in_box: [+zlo.toFixed(2), +zhi.toFixed(2)]
    };
    const jsonOut = arg('json');
    if (jsonOut) fs.writeFileSync(jsonOut, JSON.stringify(info, null, 1));
    console.log(JSON.stringify(info));
  } finally { fs.closeSync(fd); }
}

if (require.main === module) main(process.argv.slice(2));
module.exports = { main };
