'use strict';
// Ревизия 8: толщина слоя фасада до и после «Сглаживания» / «Выровнять поверхности» на реальном скане.
//   FACADE_POS=участок.pos node dev/ui-lab/facade-eval.js     (участок — Float32 xyz подряд; ось Y — высота)
// Как получить участок из большого LAS: dev/ui-lab/README.md (раздел «Фасад»). Сам скан и вырезки в репозиторий не входят.
// Плоскость фасада подбирается устойчиво по главному слою; дальше считается разброс остатков: MAD, p10–p90, p2–p98 и доля точек в ±5 мм.
const fs = require('fs'), path = require('path');
const CP = require('../../renderer/cloud-process.js');
function load(file) { const b = fs.readFileSync(file); return new Float32Array(b.buffer.slice(b.byteOffset, b.byteOffset + b.length)); }
function fitPlane(pos, n) {
  // 1) грубая вертикальная плоскость: PCA по (x, z) и мода смещения; 2) устойчивое уточнение: 3D-PCA по точкам главного слоя (−6…+12 см от медианы), 4 прохода
  let sx = 0, sz = 0; for (let i = 0; i < n; i++) { sx += pos[i * 3]; sz += pos[i * 3 + 2]; } sx /= n; sz /= n;
  let a = 0, b = 0, c = 0; for (let i = 0; i < n; i++) { const x = pos[i * 3] - sx, z = pos[i * 3 + 2] - sz; a += x * x; b += x * z; c += z * z; }
  const th = 0.5 * Math.atan2(2 * b, a - c);
  let pl = { n: [-Math.sin(th), 0, Math.cos(th)], p: [sx, 0, sz] };
  const dist = (i) => (pos[i * 3] - pl.p[0]) * pl.n[0] + (pos[i * 3 + 1] - pl.p[1]) * pl.n[1] + (pos[i * 3 + 2] - pl.p[2]) * pl.n[2];
  const h = new Float64Array(400); for (let i = 0; i < n; i++) { const k = Math.floor((dist(i) + 1) / 0.005); if (k >= 0 && k < 400) h[k]++; }
  let mk = 0; for (let k = 0; k < 400; k++) if (h[k] > h[mk]) mk = k;
  const mode = -1 + (mk + 0.5) * 0.005; pl.p = [pl.p[0] + pl.n[0] * mode, pl.p[1], pl.p[2] + pl.n[2] * mode];
  let sel = []; for (let i = 0; i < n; i++) { const d = dist(i); if (d > -0.06 && d < 0.12) sel.push(i); }
  for (let it = 0; it < 4; it++) {
    const step = Math.max(1, Math.floor(sel.length / 400000)); let mx = 0, my = 0, mz = 0, m = 0;
    for (let k = 0; k < sel.length; k += step) { const i = sel[k] * 3; mx += pos[i]; my += pos[i + 1]; mz += pos[i + 2]; m++; } mx /= m; my /= m; mz /= m;
    let xx = 0, xy = 0, xz = 0, yy = 0, yz = 0, zz = 0;
    for (let k = 0; k < sel.length; k += step) { const i = sel[k] * 3, x = pos[i] - mx, y = pos[i + 1] - my, z = pos[i + 2] - mz; xx += x * x; xy += x * y; xz += x * z; yy += y * y; yz += y * z; zz += z * z; }
    const tr = xx + yy + zz; let v = pl.n.slice();
    for (let q = 0; q < 200; q++) { const x = v[0], y = v[1], z = v[2]; const nx = tr * x - (xx * x + xy * y + xz * z), ny = tr * y - (xy * x + yy * y + yz * z), nz = tr * z - (xz * x + yz * y + zz * z), l = Math.hypot(nx, ny, nz); v = [nx / l, ny / l, nz / l]; }
    pl = { n: v, p: [mx, my, mz] };
    const ds = sel.map(dist), sorted = Float64Array.from(ds).sort(), med = sorted[sorted.length >> 1];
    pl.p = [mx + v[0] * med, my + v[1] * med, mz + v[2] * med];
    const keep = []; for (let i = 0; i < n; i++) { const d = dist(i); if (d > -0.06 && d < 0.12) keep.push(i); } sel = keep;
  }
  return pl;
}
function resid(pos, n, pl) { const r = new Float32Array(n); for (let i = 0; i < n; i++) r[i] = (pos[i * 3] - pl.p[0]) * pl.n[0] + (pos[i * 3 + 1] - pl.p[1]) * pl.n[1] + (pos[i * 3 + 2] - pl.p[2]) * pl.n[2]; return r; }
function thick(r, n) {
  const sel = []; for (let i = 0; i < n; i++) if (Math.abs(r[i]) < 0.12) sel.push(r[i]); sel.sort((x, y) => x - y);
  const q = (p) => sel[Math.floor(p * (sel.length - 1))]; let in5 = 0; for (const d of sel) if (Math.abs(d) <= 0.005) in5++;
  return { madMM: +(1000 * 0.5 * (q(0.75) - q(0.25)) / 0.6745).toFixed(1), p10_90: +(1000 * (q(0.9) - q(0.1))).toFixed(1), p2_98: +(1000 * (q(0.98) - q(0.02))).toFixed(1), in5: +(in5 / sel.length).toFixed(3) };
}
if (require.main === module) {
  const file = process.env.FACADE_POS; if (!file) { console.error('Укажите FACADE_POS=файл.pos'); process.exit(2); }
  const pos = load(file), n = pos.length / 3, pl = fitPlane(pos, n), sp = CP.estimate(pos, n).spacing;
  console.log('точек', n, 'шаг ≈', (sp * 1000).toFixed(1), 'мм');
  console.log('исходное'.padEnd(34), JSON.stringify(thick(resid(pos, n, pl), n)));
  const go = (tag, op, par) => { const p = new Float32Array(pos), r = CP.run(op, p, par); console.log(tag.padEnd(34), JSON.stringify(thick(resid(r.pos || p, n, pl), n))); };
  go('сглаживание 3 см', 'smooth', { radius: 0.03, strength: 1, protect: true });
  go('выровнять 3 см (по умолчанию)', 'flatten', { tol: 0.03, strength: 1, spacing: sp });
  go('выровнять 6 см', 'flatten', { tol: 0.06, strength: 1, spacing: sp });
  go('выровнять «Фасад, стекло»', 'flatten', { tol: 0.12, strength: 1, spacing: sp, cell: 0.6 });
}
module.exports = { fitPlane, resid, thick };
