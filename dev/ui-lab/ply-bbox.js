// Габарит облака по PLY-файлу (как центрирует приложение при загрузке): вершины читаются кусками, x/y/z — float32 в записи.
// Общий код стенда для real-snap.js и real-e2e.js (не часть продукта).
const fs = require('fs');
const SZ = { char: 1, uchar: 1, int8: 1, uint8: 1, short: 2, ushort: 2, int16: 2, uint16: 2, int: 4, uint: 4, float: 4, int32: 4, uint32: 4, float32: 4, double: 8, float64: 8 };
function plyBbox(file) {
  const fd = fs.openSync(file, 'r'), head = Buffer.alloc(4096); fs.readSync(fd, head, 0, 4096, 0);
  const hs = head.toString('latin1'), he = hs.indexOf('end_header'), off = hs.indexOf('\n', he) + 1;
  let rec = 0, inV = false, ox = -1, nv = 0;
  for (const l of hs.slice(0, off).split(/\r?\n/)) {
    const t = l.trim().split(/\s+/);
    if (t[0] === 'element') { inV = t[1] === 'vertex'; if (inV) nv = +t[2]; } else if (inV && t[0] === 'property') { if (t[2] === 'x') ox = rec; rec += SZ[t[1]] || 4; }
  }
  const mn = [Infinity, Infinity, Infinity], mx = [-Infinity, -Infinity, -Infinity], CH = 200000, buf = Buffer.alloc(CH * rec);
  for (let i = 0; i < nv; i += CH) {
    const k = Math.min(CH, nv - i); fs.readSync(fd, buf, 0, k * rec, off + i * rec);
    for (let j = 0; j < k; j++) for (let c = 0; c < 3; c++) { const v = buf.readFloatLE(j * rec + ox + 4 * c); if (v < mn[c]) mn[c] = v; if (v > mx[c]) mx[c] = v; }
  }
  fs.closeSync(fd); return { mn, mx, nv };
}
module.exports = { plyBbox };
