'use strict';
/**
 * Ревизия 54: вырезать кусок облака LAS по рамке (и, если нужно, по времени точек) в новый LAS.
 * Нужно для замеров: «окно 120 с» на фасаде — это кусок большой съёмки, а не весь файл.
 *
 *   node tools/las-crop.js in.las out.las --box x0,y0,z0,x1,y1,z1 [--time t0,t1] [--max 5000000]
 *
 * Пишет обычный LAS того же формата: заголовок копируется, число точек и рамка пересчитываются.
 * Возврат (и строка JSON в stdout): { ok, points, in, bbox, t0, t1, xbin? }.
 */
const fs = require('node:fs');
const path = require('node:path');

/**
 * crop(src, dst, opt, onProgress) → { ok, points, in, bbox, t0, t1, timeOk }
 *   opt: { box: [x0,y0,z0,x1,y1,z1], time: [t0,t1], max: N }
 */
function crop(src, dst, opt, onProgress) {
  const R = require('../scan-refine-core');
  const o = opt || {}, prog = typeof onProgress === 'function' ? onProgress : () => {};
  const box = o.box ? o.box.map(Number) : null;
  if (!box || box.length !== 6 || box.some(v => !Number.isFinite(v))) throw new Error('нужна рамка box: x0,y0,z0,x1,y1,z1');
  const [x0, y0, z0, x1, y1, z1] = box;
  const tm = o.time ? o.time.map(Number) : null;
  if (tm && (tm.length !== 2 || tm.some(v => !Number.isFinite(v)))) throw new Error('неверное время time: t0,t1');
  const max = Number(o.max) > 0 ? Number(o.max) : Infinity;
  const fd = fs.openSync(src, 'r');
  let ofd = null;
  try {
    const H = R.readHeader(fd);
    const rl = H.rl;
    const hb = Buffer.alloc(H.off); fs.readSync(fd, hb, 0, H.off, 0);
    ofd = fs.openSync(dst, 'w+');
    fs.writeSync(ofd, hb, 0, H.off, 0);
    let wpos = H.off, out = 0, t0 = Infinity, t1 = -Infinity, skipped = 0, capped = 0;
    const bb = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity];
    const per = 1 << 18, buf = Buffer.allocUnsafe(per * rl);
    for (let i = 0; i < H.n; i += per) {
      const c = Math.min(per, H.n - i), bytes = c * rl; let got = 0;
      while (got < bytes) { const r = fs.readSync(fd, buf, got, bytes - got, H.off + i * rl + got); if (!r) throw new Error('файл LAS обрезан'); got += r; }
      let w = 0;
      for (let q = 0, p = 0; q < c; q++, p += rl) {
        const x = buf.readInt32LE(p) * H.sx + H.ox, y = buf.readInt32LE(p + 4) * H.sy + H.oy, z = buf.readInt32LE(p + 8) * H.sz + H.oz;
        if (x < x0 || x > x1 || y < y0 || y > y1 || z < z0 || z > z1) { skipped++; continue; }
        let t = 0;
        if (H.tOff !== undefined) { t = buf.readDoubleLE(p + H.tOff); if (tm && (t < tm[0] || t > tm[1])) { skipped++; continue; } }
        if (out >= max) { capped++; continue; }
        if (w !== p) buf.copy(buf, w, p, p + rl);
        w += rl; out++;
        if (H.tOff !== undefined) { if (t < t0) t0 = t; if (t > t1) t1 = t; }
        if (x < bb[0]) bb[0] = x; if (y < bb[1]) bb[1] = y; if (z < bb[2]) bb[2] = z;
        if (x > bb[3]) bb[3] = x; if (y > bb[4]) bb[4] = y; if (z > bb[5]) bb[5] = z;
      }
      if (w) { fs.writeSync(ofd, buf, 0, w, wpos); wpos += w; }
      prog((i + c) / H.n, 'Вырезание куска…');
    }
    if (!out) { fs.closeSync(ofd); ofd = null; fs.rmSync(dst, { force: true }); throw new Error('в рамке нет точек'); }
    R.finishLas(ofd, H, out, bb, wpos);
    return { ok: true, points: out, in: H.n, bbox: bb, t0: Number.isFinite(t0) ? t0 : null, t1: Number.isFinite(t1) ? t1 : null, skipped, capped };
  } catch (e) {
    if (ofd !== null) { try { fs.closeSync(ofd); } catch (_) {} try { fs.rmSync(dst, { force: true }); } catch (_) {} }
    throw e;
  } finally { if (ofd !== null) { try { fs.closeSync(ofd); } catch (_) {} } fs.closeSync(fd); }
}

function main(argv) {
  const [src, dst] = argv;
  if (!src || !dst) { console.error('нужно: node tools/las-crop.js in.las out.las --box x0,y0,z0,x1,y1,z1 [--time t0,t1] [--max N]'); process.exit(2); }
  const arg = (k) => { const i = argv.findIndex(a => a === '--' + k || a.startsWith('--' + k + '=')); return i >= 0 ? (argv[i].includes('=') ? argv[i].slice(argv[i].indexOf('=') + 1) : argv[i + 1]) : null; };
  const list = (k) => { const v = arg(k); return v ? v.split(',').map(Number) : null; };
  const opt = { box: list('box'), time: list('time'), max: arg('max') ? Number(arg('max')) : undefined };
  try {
    let last = -1;
    const r = crop(path.resolve(src), path.resolve(dst), opt, (f, l) => { const p = Math.floor(f * 20); if (p !== last) { last = p; process.stderr.write(l + ' ' + Math.round(f * 100) + '%\n'); } });
    console.log(JSON.stringify(r));
  } catch (e) { console.error(String((e && e.message) || e)); process.exit(1); }
}

module.exports = { crop };
if (require.main === module) main(process.argv.slice(2));
