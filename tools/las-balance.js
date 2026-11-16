// node tools/las-balance.js in.las out.las [json-opts|@file] — VOXEL-балансировка плотности готового LAS (r146).
// Мультипроходные облака дают на плоскостях смесь плотных и разреженных участков. Балансировка оставляет не более
// cap точек на воксель поверхности (по умолчанию 2 см / 20 точек) — «ковёр» становится ровным, разреженные участки
// не трогаются (точки не добавляются). Формат/цвет/время сохраняются, заголовок пересчитывается.
const fs = require('node:fs');
const R = require('../scan-refine-core');
const [src, dst, o] = process.argv.slice(2);
if (!src || !dst) { console.error('нужно: las-balance.js in.las out.las [json|@file]'); process.exit(2); }
const opt = !o ? {} : (o[0] === '@' ? JSON.parse(fs.readFileSync(o.slice(1), 'utf8')) : JSON.parse(o));
const voxel = Number(opt.voxel) > 0 ? Number(opt.voxel) : 0.02;
const cap = Number.isInteger(opt.cap) && opt.cap > 0 ? opt.cap : 20;
const fd = fs.openSync(src, 'r');
let ofd = null;
try {
  const H = R.readHeader(fd), rl = H.rl;
  const hb = Buffer.alloc(H.off); fs.readSync(fd, hb, 0, hb.length, 0);
  ofd = fs.openSync(dst, 'w+'); fs.writeSync(ofd, hb, 0, hb.length, 0);
  const MASK = (1 << 22) - 1, cnt = new Uint16Array(1 << 22);
  const per = 1 << 18, buf = Buffer.allocUnsafe(per * rl);
  const bb = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity];
  let wpos = H.off, out = 0, removed = 0, t0 = Date.now();
  for (let i = 0; i < H.n; i += per) {
    const c = Math.min(per, H.n - i), bytes = c * rl; let got = 0;
    while (got < bytes) { const r = fs.readSync(fd, buf, got, bytes - got, H.off + i * rl + got); if (!r) throw new Error('LAS обрезан'); got += r; }
    let w = 0;
    for (let q = 0, p = 0; q < c; q++, p += rl) {
      const x = buf.readInt32LE(p) * H.sx + H.ox, y = buf.readInt32LE(p + 4) * H.sy + H.oy, z = buf.readInt32LE(p + 8) * H.sz + H.oz;
      const k = (Math.imul(Math.floor(x / voxel), 73856093) ^ Math.imul(Math.floor(y / voxel), 19349663) ^ Math.imul(Math.floor(z / voxel), 83492791)) & MASK;
      if (cnt[k] >= cap) { removed++; continue; }
      cnt[k]++;
      if (w !== p) buf.copy(buf, w, p, p + rl);
      if (x < bb[0]) bb[0] = x; if (y < bb[1]) bb[1] = y; if (z < bb[2]) bb[2] = z;
      if (x > bb[3]) bb[3] = x; if (y > bb[4]) bb[4] = y; if (z > bb[5]) bb[5] = z;
      w += rl; out++;
    }
    if (w) { fs.writeSync(ofd, buf, 0, w, wpos); wpos += w; }
  }
  if (!out) throw new Error('в LAS не осталось точек');
  R.finishLas(ofd, H, out, bb, wpos);
  fs.closeSync(ofd); ofd = null;
  console.log(JSON.stringify({ ok: true, points: out, removed, voxel, cap, ms: Date.now() - t0 }));
} catch (e) {
  if (ofd !== null) { try { fs.closeSync(ofd); } catch (_) {} try { fs.rmSync(dst, { force: true }); } catch (_) {} }
  throw e;
} finally { fs.closeSync(fd); }
