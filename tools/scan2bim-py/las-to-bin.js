'use strict';
/**
 * Ревизия r109 (фаза 2): LAS → бинарное облако для Python-движка scan2bim-v2.py в том же
 * кадре, что отдаёт las-node.js (вьюер Y-up, основание на земле, центр по X/Z):
 *
 *   pos = ( X - cx, Z - mnz, -(Y - cy) )   // X,Y,Z — мировые координаты LAS
 *
 * В отличие от _scratch/dump-local.js пишет 6 float32 на точку (x,y,z,r,g,b) и умеет
 * резать по рамке, не загружая весь файл в память (важно для map.las 5.7 ГБ / 175 млн).
 *
 *   node tools/scan2bim-py/las-to-bin.js in.las out.bin [--box=x0,y0,z0,x1,y1,z1]
 *                                    [--max=4000000] [--stride=N] [--json=meta.json]
 *
 * Возврат: строка JSON {points, in, selected, stride, origin, min, max} (+ файл meta).
 */
const fs = require('node:fs');
const path = require('node:path');

const RGB_OFF = { 2: 20, 3: 28, 5: 28, 7: 30, 8: 30, 10: 30 };

function readHeader(fd) {
  const h = Buffer.alloc(375);
  fs.readSync(fd, h, 0, 375, 0);
  if (h.toString('latin1', 0, 4) !== 'LASF') throw new Error('файл не LAS');
  const minor = h[25], off = h.readUInt32LE(96), fmt = h[104] & 0x3f, rl = h.readUInt16LE(105);
  if (h[104] & 0x80) throw new Error('сжатый LAZ не поддерживается — нужен обычный LAS');
  let n = h.readUInt32LE(107);
  if (minor >= 4) { const n2 = Number(h.readBigUInt64LE(247)); if (n2 > 0) n = n2; }
  return {
    minor, off, fmt, rl, n,
    rgb: RGB_OFF[fmt],
    sx: h.readDoubleLE(131), sy: h.readDoubleLE(139), sz: h.readDoubleLE(147),
    ox: h.readDoubleLE(155), oy: h.readDoubleLE(163), oz: h.readDoubleLE(171),
    hMinZ: h.readDoubleLE(219), hMaxZ: h.readDoubleLE(211)
  };
}

function forEachChunk(fd, H, cb) {
  const per = 1 << 18;
  const buf = Buffer.allocUnsafe(per * H.rl);
  for (let i = 0; i < H.n; i += per) {
    const c = Math.min(per, H.n - i), bytes = c * H.rl;
    let got = 0;
    while (got < bytes) {
      const r = fs.readSync(fd, buf, got, bytes - got, H.off + i * H.rl + got);
      if (!r) throw new Error('файл LAS обрезан');
      got += r;
    }
    cb(buf, i, c);
  }
}

function pointAt(buf, p, H) {
  return [buf.readInt32LE(p) * H.sx + H.ox, buf.readInt32LE(p + 4) * H.sy + H.oy, buf.readInt32LE(p + 8) * H.sz + H.oz];
}

function run(src, dst, opt) {
  opt = opt || {};
  const box = opt.box || null;
  const maxN = Number(opt.max) > 0 ? Number(opt.max) : 4000000;
  const fd = fs.openSync(src, 'r');
  try {
    const H = readHeader(fd);
    const inBox = box ? (x, y, z) => x >= box[0] && x <= box[3] && y >= box[1] && y <= box[4] && z >= box[2] && z <= box[5] : () => true;
    // ---------- проход 1: число точек в рамке, габариты относительно первой точки, цвет ----------
    let selected = 0, sh = null, mnx = Infinity, mny = Infinity, mnz = Infinity, mxx = -Infinity, mxy = -Infinity, mxz = -Infinity;
    let maxC = 0;
    const colOff = H.rgb;
    const sampleRGB = colOff !== undefined;
    forEachChunk(fd, H, (buf, i0, c) => {
      for (let q = 0, p = 0; q < c; q++, p += H.rl) {
        const pt = pointAt(buf, p, H);
        if (!inBox(pt[0], pt[1], pt[2])) continue;
        if (sh === null) sh = pt;
        const wx = pt[0] - sh[0], wy = pt[1] - sh[1], wz = pt[2] - sh[2];
        if (wx < mnx) mnx = wx; if (wx > mxx) mxx = wx;
        if (wy < mny) mny = wy; if (wy > mxy) mxy = wy;
        if (wz < mnz) mnz = wz; if (wz > mxz) mxz = wz;
        selected++;
        if (sampleRGB) {
          const c0 = buf.readUInt16LE(p + colOff), c1 = buf.readUInt16LE(p + colOff + 2), c2 = buf.readUInt16LE(p + colOff + 4);
          if (c0 > maxC) maxC = c0; if (c1 > maxC) maxC = c1; if (c2 > maxC) maxC = c2;
        }
      }
    });
    if (!selected || sh === null) throw new Error('в рамке нет точек');
    const stride = Number(opt.stride) > 0 ? Math.floor(Number(opt.stride)) : Math.max(1, Math.ceil(selected / maxN));
    const outN = Math.ceil(selected / stride);
    const cx = (mnx + mxx) / 2, cy = (mny + mxy) / 2;
    const colDiv = sampleRGB ? (maxC > 255 ? 65535 : 255) : 1;
    const hasColor = sampleRGB && maxC > 0;
    console.log(JSON.stringify({
      phase: 'header', in: H.n, selected, stride, out: outN, maxColor: maxC, colorDiv: colDiv,
      absolute: { x: [sh[0] + mnx, sh[0] + mxx], y: [sh[1] + mny, sh[1] + mxy], z: [sh[2] + mnz, sh[2] + mxz] }
    }));
    // ---------- проход 2: запись float32 x,y,z,r,g,b ----------
    const arr = new Float32Array(outN * 6);
    let k = 0, sel = 0, ofd = fs.openSync(dst, 'w');
    try {
      forEachChunk(fd, H, (buf, i0, c) => {
        for (let q = 0, p = 0; q < c; q++, p += H.rl) {
          const pt = pointAt(buf, p, H);
          if (!inBox(pt[0], pt[1], pt[2])) continue;
          const take = (sel % stride) === 0;
          sel++;
          if (!take) continue;
          // кадр las-node.js один-в-один: сначала X-sh пишется в Float32Array, затем из
          // прочитанного float32 вычитается центр — повторяем двойное округление, иначе
          // точки у границ 5-см ячеек могут попасть в соседнюю клетку (окна «дробятся»).
          const px32 = Math.fround(pt[0] - sh[0]);
          const py32 = Math.fround(pt[1] - sh[1]);
          const pz32 = Math.fround(pt[2] - sh[2]);
          arr[k++] = Math.fround(px32 - cx);
          arr[k++] = Math.fround(pz32 - mnz);
          arr[k++] = Math.fround(-(py32 - cy));
          if (hasColor) {
            arr[k++] = buf.readUInt16LE(p + colOff) / colDiv;
            arr[k++] = buf.readUInt16LE(p + colOff + 2) / colDiv;
            arr[k++] = buf.readUInt16LE(p + colOff + 4) / colDiv;
          } else {
            const t = Math.max(0, Math.min(1, (pt[2] - sh[2] - mnz) / (mxz - mnz || 1)));
            arr[k++] = 1.5 - Math.abs(4 * t - 3);
            arr[k++] = 1.5 - Math.abs(4 * t - 2);
            arr[k++] = 1.5 - Math.abs(4 * t - 1);
          }
        }
      });
      fs.writeSync(ofd, Buffer.from(arr.buffer, 0, k * 4), 0, k * 4);
    } finally { fs.closeSync(ofd); }
    // origin в абсолютных координатах LAS — для перевода мировых координат бина обратно в LAS
    const origin = { ox: cx + sh[0], oy: cy + sh[1], oz: mnz + sh[2] };
    const min = [-cx, -mnz, -cy - (mxy - mny) / 2 + (mxy - mny) / 2];
    const info = {
      ok: true, in: H.n, selected, points: k / 6, stride: Math.floor(stride),
      frame: 'yup', origin, box: box || null,
      min: [-cx, -mnz, 0], max: [mxx - cx, mxz - mnz, 0],
      bbox: { x: [mxx - cx, mnx - cx], y: [0, mxz - mnz], z: [0, 0] },
      src: path.basename(src), bin: path.basename(dst), bytes: k * 4
    };
    // min/max по фактически записанным точкам — пересчитываем (stride мог отсечь крайние)
    let fmn = [Infinity, Infinity, Infinity], fmx = [-Infinity, -Infinity, -Infinity];
    for (let i = 0; i < k; i += 6) for (let q = 0; q < 3; q++) { const v = arr[i + q]; if (v < fmn[q]) fmn[q] = v; if (v > fmx[q]) fmx[q] = v; }
    info.min = fmn.map(v => +v.toFixed(4)); info.max = fmx.map(v => +v.toFixed(4));
    if (opt.jsonOut) fs.writeFileSync(opt.jsonOut, JSON.stringify(info, null, 1));
    return info;
  } finally { fs.closeSync(fd); }
}

function main(argv) {
  const [src, dst] = argv;
  if (!src || !dst) { console.error('нужно: node tools/scan2bim-py/las-to-bin.js in.las out.bin [--box=...] [--max=N] [--stride=N] [--json=meta.json]'); process.exit(2); }
  const arg = (k) => { const i = argv.findIndex(a => a === '--' + k || a.startsWith('--' + k + '=')); return i >= 0 ? (argv[i].includes('=') ? argv[i].slice(argv[i].indexOf('=') + 1) : argv[i + 1]) : null; };
  const boxStr = arg('box');
  const opt = {
    box: boxStr ? boxStr.split(',').map(Number) : null,
    max: arg('max') ? Number(arg('max')) : undefined,
    stride: arg('stride') ? Number(arg('stride')) : undefined,
    jsonOut: arg('json')
  };
  try {
    const info = run(path.resolve(src), path.resolve(dst), opt);
    console.log(JSON.stringify(info));
  } catch (e) { console.error(String((e && e.message) || e)); process.exit(1); }
}

module.exports = { run };
if (require.main === module) main(process.argv.slice(2));
