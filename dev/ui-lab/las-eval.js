// Оценка авто-чистки на реальной вырезке LAS (не часть продукта). Пишет облака «до/после» в бинарные файлы для рендера в Python.
//   LAS=/data/work/r11/tile_P2.las MODE=people|denoise|all PRESET=normal node dev/ui-lab/las-eval.js
const fs = require('fs'), path = require('path');
const CC = require('../../renderer/cloud-clean.js');
function readLas(file) {
  const fd = fs.openSync(file, 'r'), h = Buffer.alloc(227); fs.readSync(fd, h, 0, 227, 0);
  const off = h.readUInt32LE(96), rec = h.readUInt16LE(105), n = h.readUInt32LE(107), sc = [h.readDoubleLE(131), h.readDoubleLE(139), h.readDoubleLE(147)], of = [h.readDoubleLE(155), h.readDoubleLE(163), h.readDoubleLE(171)];
  const pos = new Float32Array(n * 3), col = new Uint8Array(n * 3), gps = new Float64Array(n), CH = 1 << 20, b = Buffer.alloc(CH * rec);
  for (let s = 0; s < n; s += CH) {
    const m = Math.min(CH, n - s); fs.readSync(fd, b, 0, m * rec, off + s * rec);
    for (let i = 0; i < m; i++) {
      const o = i * rec, j = s + i, x = b.readInt32LE(o) * sc[0] + of[0], y = b.readInt32LE(o + 4) * sc[1] + of[1], z = b.readInt32LE(o + 8) * sc[2] + of[2];
      pos[j * 3] = x; pos[j * 3 + 1] = z; pos[j * 3 + 2] = -y; // Y вверх, как в приложении
      col[j * 3] = Math.min(255, b.readUInt16LE(o + 28)); col[j * 3 + 1] = Math.min(255, b.readUInt16LE(o + 30)); col[j * 3 + 2] = Math.min(255, b.readUInt16LE(o + 32));
      gps[j] = b.readDoubleLE(o + 20);
    }
  }
  fs.closeSync(fd); return { pos, col, gps, n };
}
function writeKept(out, S, remove) {
  const gone = new Uint8Array(S.n); for (const i of remove) gone[i] = 1;
  const keep = []; for (let i = 0; i < S.n; i++) if (!gone[i]) keep.push(i);
  const buf = Buffer.alloc(keep.length * 15);
  keep.forEach((i, k) => { const o = k * 15; buf.writeFloatLE(S.pos[i * 3], o); buf.writeFloatLE(S.pos[i * 3 + 1], o + 4); buf.writeFloatLE(S.pos[i * 3 + 2], o + 8); buf[o + 12] = S.col[i * 3]; buf[o + 13] = S.col[i * 3 + 1]; buf[o + 14] = S.col[i * 3 + 2]; });
  fs.writeFileSync(out, buf); return keep.length;
}
module.exports = { readLas, writeKept };
if (require.main === module) {
  const file = process.env.LAS, tag = path.basename(file, '.las'), S = readLas(file), mode = process.env.MODE || 'all';
  console.log(tag, 'точек', S.n);
  const outDir = process.env.OUT || '/data/work/r11/eval'; fs.mkdirSync(outDir, { recursive: true });
  const rem = new Set();
  if (mode === 'denoise' || mode === 'all' || mode === 'dn+fl') {
    const t = Date.now(), r = CC.denoise(S.pos, S.n, { level: process.env.PRESET || 'medium' });
    console.log('denoise', (Date.now() - t) + ' мс', 'удалено', r.removed, (100 * r.removed / S.n).toFixed(2) + ' %', JSON.stringify(r.stats)); r.remove.forEach((i) => rem.add(i));
  }
  if (mode === 'people' || mode === 'all' || mode === 'v2') {
    const t = Date.now(), r = mode === 'v2' ? CC.run(CC.peopleV2Gen(S.pos, S.n, { level: process.env.LEVEL || 'normal' })) : CC.people(S.pos, S.n, { level: process.env.LEVEL || 'normal' });
    if (r.stats) console.log(JSON.stringify(r.stats));
    console.log('people', (Date.now() - t) + ' мс', 'удалено', r.removed, 'найдено', r.found.length, r.found.map((f) => `(${f.cx.toFixed(1)},${(-f.cz).toFixed(1)} h${f.h.toFixed(2)})`).join(' ')); r.remove.forEach((i) => rem.add(i));
  }
  let S2 = S;
  if (mode === 'flatten' || mode === 'all') {
    const CP = require('../../renderer/cloud-process.js'), est = CP.estimate(S.pos, S.n), t = Date.now(), facade = !!process.env.FACADE;
    const r = CP.flatten(S.pos.slice(), S.n, { tol: +(process.env.TOL || (facade ? 0.12 : 0.03)), strength: 1, spacing: est.spacing, cell: facade ? 0.6 : undefined });
    console.log('flatten', (Date.now() - t) + ' мс', 'плоскостей', r.planes, 'сдвинуто', r.moved, 'rms', r.rmsShift, 'шаг', est.spacing); S2 = Object.assign({}, S, { pos: r.pos });
  }
  if (mode === 'auto') {
    const t = Date.now(), r = CC.autoClean(S.pos, S.n, { level: process.env.PRESET || 'medium', facade: !!process.env.FACADE, tol: process.env.TOL ? +process.env.TOL : undefined, hair: process.env.HAIR !== '0' });
    console.log('auto', (Date.now() - t) + ' мс', JSON.stringify(r.stats)); r.remove.forEach((i) => rem.add(i)); S2 = Object.assign({}, S, { pos: r.pos });
  }
  console.log('после:', writeKept(path.join(outDir, tag + '_' + (process.env.TAG || mode) + '.bin'), S2, rem), 'из', S.n);
}
