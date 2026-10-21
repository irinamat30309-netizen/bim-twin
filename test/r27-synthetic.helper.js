'use strict';
// ревизия 27: синтетическое здание для тестов карты, плана и фильтров (без побочных действий при запуске)
const fs = require('fs');
function rng(seed) { let s = seed >>> 0 || 1; return () => { s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0; return s / 4294967296; }; }
function gauss(r) { let u = 0, v = 0; while (u === 0) u = r(); v = r(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); }
function building(o) {
  o = o || {}; const step = o.step || 0.03, noise = o.noise == null ? 0.003 : o.noise, H = 2.8, r = rng(o.seed || 7);
  const P = [];   // [x, y, z] локально
  const wallV = (x0, y0, x1, y1, holes) => {   // вертикальная грань от (x0,y0) до (x1,y1)
    const L = Math.hypot(x1 - x0, y1 - y0), nu = Math.ceil(L / step), nz = Math.ceil(H / step);
    const nx = -(y1 - y0) / L, ny = (x1 - x0) / L;
    for (let i = 0; i <= nu; i++) for (let k = 0; k <= nz; k++) {
      const t = (i + r() * 0.5) / nu * L, z = (k + r() * 0.5) / nz * H;
      if (t > L || z > H) continue;
      if (holes && holes.some(h => t >= h[0] && t <= h[1] && z >= h[2] && z <= h[3])) continue;
      let e = gauss(r) * noise;
      if (o.wallDip) { const q = o.wallDip, wx = x0 + (x1 - x0) * t / L, wy = y0 + (y1 - y0) * t / L, d = Math.hypot(wx - q.x, wy - q.y, z - q.z); if (d < q.r) e -= q.depth * (d < q.r * 0.7 ? 1 : (q.r - d) / (q.r * 0.3)); }
      P.push([x0 + (x1 - x0) * t / L + nx * e, y0 + (y1 - y0) * t / L + ny * e, z]);
    }
  };
  const bump = (x, y, z) => { const q = o.bump; if (!q || z > 0.01) return 0; const d = Math.hypot(x - q.x, y - q.y); return d < q.r ? q.h * (d < q.r * 0.7 ? 1 : (q.r - d) / (q.r * 0.3)) : 0; };
  const slab = (x0, y0, x1, y1, z) => { for (let x = x0; x <= x1; x += step) for (let y = y0; y <= y1; y += step) { const px = x + r() * step * 0.5, py = y + r() * step * 0.5; P.push([px, py, z + bump(px, py, z) + gauss(r) * noise]); } };
  // помещение A: x 0..6, y 0..6; B: x 6.12..10, y 0..6
  wallV(0, 0, 6, 0, [[2, 3.5, 0.9, 2.1]]);          // юг A с окном x 2..3.5
  wallV(6, 0, 6, 6, [[2.0, 2.9, 0, 2.1]]);          // перегородка, сторона A, дверь y 2.0..2.9
  wallV(6, 6, 0, 6); wallV(0, 6, 0, 0);
  wallV(6.12, 0, 10, 0); wallV(10, 0, 10, 6); wallV(10, 6, 6.12, 6);
  wallV(6.12, 6, 6.12, 0, [[6 - 2.9, 6 - 2.0, 0, 2.1]]);   // перегородка, сторона B (направление сверху вниз)
  slab(0, 0, 6, 6, 0); slab(6.12, 0, 10, 6, 0); slab(0, 0, 6, 6, H); slab(6.12, 0, 10, 6, H);
  // ревизия 32: наклон облака (мм/м): верх смещён на tilt·z, горизонтальные плоскости наклонены навстречу (малый поворот)
  if (o.tilt) { const tu = o.tilt[0] / 1000, tv = o.tilt[1] / 1000; for (const p of P) { const x = p[0], y = p[1], z = p[2]; p[0] = x + tu * z; p[1] = y + tv * z; p[2] = z - tu * x - tv * y; } }
  // поворот на theta и сдвиг
  const th = (o.theta == null ? 17 : o.theta) * Math.PI / 180, c = Math.cos(th), s = Math.sin(th), tx = o.tx || 12.34, ty = o.ty || -5.67;
  const W = P.map(p => [500000 + tx + p[0] * c - p[1] * s, 4000000 + ty + p[0] * s + p[1] * c, 100 + p[2]]);
  // перемешивание (сканер пишет точки во времени — порядок не по местам)
  for (let i = W.length - 1; i > 0; i--) { const j = Math.floor(r() * (i + 1)); const t = W[i]; W[i] = W[j]; W[j] = t; }
  // маршрут: по A, через дверь в B
  const route = [[1, 1], [5, 1], [5, 2.45], [8, 2.45], [8, 5], [3, 5], [1, 1]];
  const poses = []; let t = 0;
  for (let k = 0; k + 1 < route.length; k++) { const a = route[k], b = route[k + 1], L = Math.hypot(b[0] - a[0], b[1] - a[1]), m = Math.ceil(L / 0.05);
    for (let i = 0; i < m; i++) { const x = a[0] + (b[0] - a[0]) * i / m, y = a[1] + (b[1] - a[1]) * i / m; poses.push([t, 500000 + tx + x * c - y * s, 4000000 + ty + x * s + y * c, 100 + 1.3]); t += 0.05; } }
  return { pts: W, poses, theta: th, tx, ty };
}
function writeLas(file, pts, opts) {
  opts = opts || {};
  const H = 227, fmt = 3, rec = 34, n = pts.length, hd = Buffer.alloc(H); hd.write('LASF', 0); hd.writeUInt8(1, 24); hd.writeUInt8(2, 25);
  hd.write('BIM Twin test', 26); hd.write('synthetic r27', 58); hd.writeUInt16LE(120, 90); hd.writeUInt16LE(2026, 92);
  hd.writeUInt16LE(H, 94); hd.writeUInt32LE(H, 96); hd.writeUInt8(fmt, 104); hd.writeUInt16LE(rec, 105); hd.writeUInt32LE(n, 107);
  const sc = 0.0005; hd.writeDoubleLE(sc, 131); hd.writeDoubleLE(sc, 139); hd.writeDoubleLE(sc, 147); hd.writeDoubleLE(500000, 155); hd.writeDoubleLE(4000000, 163); hd.writeDoubleLE(100, 171);
  const mn = [1e18, 1e18, 1e18], mx = [-1e18, -1e18, -1e18], body = Buffer.alloc(n * rec);
  for (let i = 0; i < n; i++) {
    const p = pts[i], b = i * rec;
    const X = Math.round((p[0] - 500000) / sc), Y = Math.round((p[1] - 4000000) / sc), Z = Math.round((p[2] - 100) / sc);
    const w = [X * sc + 500000, Y * sc + 4000000, Z * sc + 100]; for (let k = 0; k < 3; k++) { if (w[k] < mn[k]) mn[k] = w[k]; if (w[k] > mx[k]) mx[k] = w[k]; }
    body.writeInt32LE(X, b); body.writeInt32LE(Y, b + 4); body.writeInt32LE(Z, b + 8); body.writeUInt16LE(20000 + (i % 30000), b + 12);
    body.writeDoubleLE(i * 1e-4, b + 20);
    const g = Math.max(0, Math.min(65535, Math.round((p[2] - 100) / 3 * 65535))); body.writeUInt16LE(40000, b + 28); body.writeUInt16LE(g, b + 30); body.writeUInt16LE(30000, b + 32);
  }
  hd.writeDoubleLE(mx[0], 179); hd.writeDoubleLE(mn[0], 187); hd.writeDoubleLE(mx[1], 195); hd.writeDoubleLE(mn[1], 203); hd.writeDoubleLE(mx[2], 211); hd.writeDoubleLE(mn[2], 219);
  fs.writeFileSync(file, Buffer.concat([hd, body]));
}
module.exports = { building, writeLas };
