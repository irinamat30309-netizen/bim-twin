// Синтетический скан для проверки потока (ревизия 12; не часть продукта): пол, четыре стены, колонны, n точек, LAS 1.2 PDRF2 (xyz + rgb).
//   node dev/ui-lab/mkscan.js /tmp/s8.las 8000000
const fs = require('fs'); const out = process.argv[2], n = +process.argv[3] || 8e6;
if (!out) { console.error('использование: node mkscan.js файл.las [число_точек]'); process.exit(2); }
const H = 227, rec = 26; const hd = Buffer.alloc(H);
hd.write('LASF', 0, 'latin1'); hd[24] = 1; hd[25] = 2; hd.writeUInt16LE(H, 94); hd.writeUInt32LE(H, 96); hd.writeUInt32LE(0, 100); hd[104] = 2; hd.writeUInt16LE(rec, 105); hd.writeUInt32LE(n, 107);
for (const o of [131, 139, 147]) hd.writeDoubleLE(0.001, o); for (const o of [155, 163, 171]) hd.writeDoubleLE(0, o);
const fd = fs.openSync(out, 'w'); fs.writeSync(fd, hd);
let s = 12345; const r = () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
const CH = 200000; let done = 0;
while (done < n) {
  const m = Math.min(CH, n - done); const b = Buffer.alloc(m * rec);
  for (let i = 0; i < m; i++) {
    const o = i * rec; let x, y, z, c; const k = r();
    if (k < 0.3) { x = r() * 50; y = r() * 40; z = 0; c = [150, 140, 130]; }
    else if (k < 0.5) { x = 0; y = r() * 40; z = r() * 12; c = [200, 190, 170]; }
    else if (k < 0.7) { x = 50; y = r() * 40; z = r() * 12; c = [190, 200, 210]; }
    else if (k < 0.85) { x = r() * 50; y = 0; z = r() * 12; c = [210, 180, 170]; }
    else if (k < 0.95) { x = r() * 50; y = 40; z = r() * 12; c = [170, 200, 180]; }
    else { const cx = 5 + Math.floor(r() * 9) * 5, cy = 5 + Math.floor(r() * 7) * 5, a = r() * 6.283; x = cx + 0.2 * Math.cos(a); y = cy + 0.2 * Math.sin(a); z = r() * 12; c = [120, 120, 140]; }
    x += (r() - .5) * 0.01; y += (r() - .5) * 0.01; z += (r() - .5) * 0.01;
    b.writeInt32LE(Math.round(x * 1000), o); b.writeInt32LE(Math.round(y * 1000), o + 4); b.writeInt32LE(Math.round(z * 1000), o + 8);
    const v = 0.7 + 0.3 * r(); b.writeUInt16LE(c[0] * 257 * v | 0, o + 20); b.writeUInt16LE(c[1] * 257 * v | 0, o + 22); b.writeUInt16LE(c[2] * 257 * v | 0, o + 24);
  }
  fs.writeSync(fd, b); done += m;
}
fs.closeSync(fd);
