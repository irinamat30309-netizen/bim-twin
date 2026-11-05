'use strict';
/**
 * tools/cloud-diff.js — что «вырезала» обработка: точки первого облака, у которых в окрестности (ячейка 0,5 м)
 * нет ни одной точки второго. Нужно, чтобы глазами проверить, не убрал ли фильтр настоящую поверхность.
 *
 *   node tools/cloud-diff.js было.las стало.las удалённое.las [--cell 0.5]
 *
 * Пишет LAS с точками «было», которых нет в «стало» (цвет и время сохраняются). Итог — JSON в stdout.
 */
const fs = require('node:fs');
const path = require('node:path');
const R = require('../scan-refine-core');

const [base, other, outPath] = process.argv.slice(2);
const cellArg = process.argv.indexOf('--cell');
const CELL = cellArg > 0 ? Number(process.argv[cellArg + 1]) : 0.5;
if (!base || !other || !outPath) { console.error('нужно: node tools/cloud-diff.js было.las стало.las удалённое.las [--cell 0.5]'); process.exit(2); }

function bbox(p) {
  const fd = fs.openSync(p, 'r'), h = Buffer.alloc(375); fs.readSync(fd, h, 0, 375, 0); fs.closeSync(fd);
  const mn = [h.readDoubleLE(187), h.readDoubleLE(203), h.readDoubleLE(219)], mx = [h.readDoubleLE(179), h.readDoubleLE(195), h.readDoubleLE(211)];
  return [mn[0] - 1, mn[1] - 1, mn[2] - 1, mx[0] + 1, mx[1] + 1, mx[2] + 1];
}
function scanPoints(p, bb, dims, cb) {
  const fd = fs.openSync(p, 'r'), H = R.readHeader(fd);
  const [x0, y0, z0] = bb, [nx, ny, nz] = dims;
  const per = 1 << 18, buf = Buffer.allocUnsafe(per * H.rl);
  for (let i = 0; i < H.n; i += per) {
    const c = Math.min(per, H.n - i); let got = 0;
    while (got < c * H.rl) { const r = fs.readSync(fd, buf, got, c * H.rl - got, H.off + i * H.rl + got); if (!r) throw new Error('файл обрезан'); got += r; }
    for (let q = 0, p2 = 0; q < c; q++, p2 += H.rl) {
      const x = buf.readInt32LE(p2) * H.sx + H.ox, y = buf.readInt32LE(p2 + 4) * H.sy + H.oy, z = buf.readInt32LE(p2 + 8) * H.sz + H.oz;
      const ix = Math.floor((x - x0) / CELL), iy = Math.floor((y - y0) / CELL), iz = Math.floor((z - z0) / CELL);
      const inside = ix >= 0 && iy >= 0 && iz >= 0 && ix < nx && iy < ny && iz < nz;
      cb(q, p2, inside ? ix + nx * (iy + ny * iz) : -1);
    }
  }
  fs.closeSync(fd);
  return H;
}

const bb = bbox(base);
const dims = [Math.ceil((bb[3] - bb[0]) / CELL) + 1, Math.ceil((bb[4] - bb[1]) / CELL) + 1, Math.ceil((bb[5] - bb[2]) / CELL) + 1];
const total = dims[0] * dims[1] * dims[2];
const has = new Uint8Array(total);
scanPoints(path.resolve(other), bb, dims, (q, p2, k) => { if (k >= 0) has[k] = 1; });

const fdIn = fs.openSync(path.resolve(base), 'r');
const H = R.readHeader(fdIn);
const hb = Buffer.alloc(H.off); fs.readSync(fdIn, hb, 0, H.off, 0);
const fdOut = fs.openSync(path.resolve(outPath), 'w+'); fs.writeSync(fdOut, hb, 0, H.off, 0);
let written = 0, kept = 0, wpos = H.off;
const bbOut = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity];
const per = 1 << 18, buf = Buffer.allocUnsafe(per * H.rl);
for (let i = 0; i < H.n; i += per) {
  const c = Math.min(per, H.n - i); let got = 0;
  while (got < c * H.rl) { const r = fs.readSync(fdIn, buf, got, c * H.rl - got, H.off + i * H.rl + got); if (!r) throw new Error('файл обрезан'); got += r; }
  let w = 0;
  for (let q = 0, p2 = 0; q < c; q++, p2 += H.rl) {
    const x = buf.readInt32LE(p2) * H.sx + H.ox, y = buf.readInt32LE(p2 + 4) * H.sy + H.oy, z = buf.readInt32LE(p2 + 8) * H.sz + H.oz;
    const ix = Math.floor((x - bb[0]) / CELL), iy = Math.floor((y - bb[1]) / CELL), iz = Math.floor((z - bb[2]) / CELL);
    const inside = ix >= 0 && iy >= 0 && iz >= 0 && ix < dims[0] && iy < dims[1] && iz < dims[2];
    if (inside && has[ix + dims[0] * (iy + dims[1] * iz)]) { kept++; continue; }
    if (w !== p2) buf.copy(buf, w, p2, p2 + H.rl);
    w += H.rl; written++;
    if (x < bbOut[0]) bbOut[0] = x; if (y < bbOut[1]) bbOut[1] = y; if (z < bbOut[2]) bbOut[2] = z;
    if (x > bbOut[3]) bbOut[3] = x; if (y > bbOut[4]) bbOut[4] = y; if (z > bbOut[5]) bbOut[5] = z;
  }
  if (w) { fs.writeSync(fdOut, buf, 0, w, wpos); wpos += w; }
}
fs.closeSync(fdIn);
if (!written) { fs.closeSync(fdOut); fs.rmSync(outPath, { force: true }); console.log(JSON.stringify({ ok: true, written: 0, kept, note: 'ничего не вырезано' })); process.exit(0); }
R.finishLas(fdOut, H, written, bbOut, wpos);
fs.closeSync(fdOut);
console.log(JSON.stringify({ ok: true, file: path.basename(outPath), cellM: CELL, written, kept, total: kept + written }));
