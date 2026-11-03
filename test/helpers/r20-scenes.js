'use strict';
// Ревизия 20: синтетические сцены для тестов — двор с прохожими в ключевых кадрах (realtime-карта) и стена/пол с «пылью».
// Двор 40×30 м, обход по кругу 1 м/с; точки только в «ключевых кадрах» (как realtime-карта XGRIDS): кадр 0,1 с каждые kf с.
// Метки: 0 — неподвижное, 1 — движущееся (люди, машина, группа, стоявшая 40 с и ушедшая), 2 — неподвижное за препятствием (видно мельком).
const fs = require('node:fs');
function writeLas(file, pts, rgb) {
  const n = pts.length / 4, H = Buffer.alloc(227), sc = 0.001, RL = 34;
  let mn = [1e9, 1e9, 1e9], mx = [-1e9, -1e9, -1e9];
  for (let i = 0; i < n; i++) for (let a = 0; a < 3; a++) { const q = pts[i * 4 + a]; if (q < mn[a]) mn[a] = q; if (q > mx[a]) mx[a] = q; }
  H.write('LASF', 0, 'latin1'); H[24] = 1; H[25] = 2; H.writeUInt16LE(227, 94); H.writeUInt32LE(227, 96); H[104] = 3; H.writeUInt16LE(RL, 105); H.writeUInt32LE(n, 107);
  H.writeDoubleLE(sc, 131); H.writeDoubleLE(sc, 139); H.writeDoubleLE(sc, 147);
  H.writeDoubleLE(mx[0], 179); H.writeDoubleLE(mn[0], 187); H.writeDoubleLE(mx[1], 195); H.writeDoubleLE(mn[1], 203); H.writeDoubleLE(mx[2], 211); H.writeDoubleLE(mn[2], 219);
  const B = Buffer.alloc(n * RL);
  for (let i = 0; i < n; i++) { const o = i * RL; B.writeInt32LE(Math.round(pts[i * 4] / sc), o); B.writeInt32LE(Math.round(pts[i * 4 + 1] / sc), o + 4); B.writeInt32LE(Math.round(pts[i * 4 + 2] / sc), o + 8); B.writeDoubleLE(pts[i * 4 + 3], o + 20);
    if (rgb) { B.writeUInt16LE(rgb[i * 3] * 256, o + 28); B.writeUInt16LE(rgb[i * 3 + 1] * 256, o + 30); B.writeUInt16LE(rgb[i * 3 + 2] * 256, o + 32); } }
  fs.writeFileSync(file, Buffer.concat([H, B]));
}
function boxHit(o, d, mn, mx, tmax) {
  let t0 = 1e-6, t1 = tmax;
  for (let a = 0; a < 3; a++) {
    if (Math.abs(d[a]) < 1e-12) { if (o[a] < mn[a] || o[a] > mx[a]) return Infinity; continue; }
    let u = (mn[a] - o[a]) / d[a], w = (mx[a] - o[a]) / d[a]; if (u > w) { const q = u; u = w; w = q; }
    if (u > t0) t0 = u; if (w < t1) t1 = w; if (t0 > t1) return Infinity;
  }
  return t0;
}
function pathAt(t) {   // прямоугольник 30×20 м (x 0…30, y 0…20), 100 м за 100 с
  let s = (t % 100); if (s < 30) return [s, 0]; s -= 30; if (s < 20) return [30, s]; s -= 20; if (s < 30) return [30 - s, 20]; s -= 30; return [0, 20 - s];
}
function yard(o) {
  o = o || {};
  const kf = o.kf || 0.5, frame = o.frame || 0.1, per = o.per || 12000, T = o.T || 100, range = o.range || 25;
  let seed = o.seed || 11; const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  const S = [   // неподвижное: ящики, столбы, поддоны, препятствие с проёмом
    { mn: [8, 5, 0], mx: [10, 7, 1.2] }, { mn: [15, 12, 0], mx: [15.3, 12.3, 3] }, { mn: [22, 6, 0], mx: [24, 8, 2.2] }, { mn: [5, 14, 0], mx: [6.2, 15, 0.8] },
    { mn: [12, 9, 0], mx: [12.1, 9.1, 2.5] }, { mn: [26, 14, 0], mx: [27, 16, 1.5] }
  ];
  // препятствие: стена x=-4…-3 по y −5…25 с проёмом y 9…10; за ней (x −9…−4) ящик — виден только через проём
  const OCC = [{ mn: [-4, -5, 0], mx: [-3.6, 9, 3] }, { mn: [-4, 10, 0], mx: [-3.6, 25, 3] }];
  const HID = { mn: [-7, 9, 0], mx: [-6, 10.5, 1.4] };
  const people = [
    t => (t >= 5 && t <= 25) ? [3 + 1.2 * (t - 5), 10] : null,              // идёт через двор
    t => (t >= 30 && t <= 50) ? [28, 2 + 0.9 * (t - 30)] : null,            // вдоль правой стороны
    t => (t >= 60 && t <= 80) ? [25 - 1.0 * (t - 60), 17 + 0.1 * (t - 60)] : null
  ];
  const group = [[14, 4], [14.7, 4.4], [15.2, 3.8]];                         // стоят 0…40 с, потом уходят
  const pts = [], lab = [], rgb = [], subl = [];
  for (let f = 0; f * kf < T; f++) {
    const tf = f * kf;
    for (let r = 0; r < per; r++) {
      const tt = tf + r * frame / per, [sx, sy] = pathAt(tt), sz = 1.6;
      const az = rnd() * 2 * Math.PI, el = Math.asin(rnd() * 1.4 - 0.9);
      const d = [Math.cos(az) * Math.cos(el), Math.sin(az) * Math.cos(el), Math.sin(el)], oo = [sx, sy, sz];
      let best = range, who = -1, sub = 0;
      if (d[2] < -1e-6) { const s = -sz / d[2]; if (s < best) { best = s; who = 0; } }
      for (const [ax, val] of [[0, -9], [0, 35], [1, -5], [1, 25]]) { if (Math.abs(d[ax]) < 1e-9) continue; const s = (val - oo[ax]) / d[ax]; if (s > 0 && s < best && sz + d[2] * s <= 12 && sz + d[2] * s >= 0) { best = s; who = 0; } }
      for (const B of S) { const s = boxHit(oo, d, B.mn, B.mx, best); if (s < best) { best = s; who = 0; } }
      for (const B of OCC) { const s = boxHit(oo, d, B.mn, B.mx, best); if (s < best) { best = s; who = 0; } }
      { const s = boxHit(oo, d, HID.mn, HID.mx, best); if (s < best) { best = s; who = 2; } }
      for (const P of people) { const p = P(tt); if (!p) continue; const s = boxHit(oo, d, [p[0] - 0.25, p[1] - 0.2, 0], [p[0] + 0.25, p[1] + 0.2, 1.75], best); if (s < best) { best = s; who = 1; sub = 1; } }
      if (tt < 40) for (const g of group) { const s = boxHit(oo, d, [g[0] - 0.25, g[1] - 0.2, 0], [g[0] + 0.25, g[1] + 0.2, 1.75], best); if (s < best) { best = s; who = 1; sub = 3; } }
      if (tt >= 52 && tt <= 58) { const px = 1 + 5 * (tt - 52); const s = boxHit(oo, d, [px - 2.2, 22, 0], [px + 2.2, 23.8, 1.5], best); if (s < best) { best = s; who = 1; sub = 4; } }
      if (who < 0) continue;
      const nz = (rnd() - 0.5) * 0.02;
      const x = sx + d[0] * (best + nz), y = sy + d[1] * (best + nz), z = sz + d[2] * (best + nz);
      // точки за препятствием, в т. ч. земля и стена за ним, — тоже «мельком»
      const behind = who === 0 && x < -3.6;
      pts.push(x, y, z, tt); lab.push(behind ? 2 : who); subl.push(sub);
      rgb.push(120, 110, 100);
    }
  }
  return { pts, lab, rgb, sub: subl };
}

// --- поверхность: кирпич со швами, плитка со швами, рама, арматура, кабель; белая пыль, туман, «лучи»
function surfaces(o) {
  o = o || {}; let seed = o.seed || 5; const rnd = () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296;
  const g = () => { let u = 0; for (let i = 0; i < 6; i++) u += rnd(); return (u - 3) / Math.sqrt(0.5); };
  const S = [0.5, -6, 1.6];   // сканер перед стеной
  const X = [], C = [], T = [], TC = [];
  const sig = o.sigma || 0.008, dens = o.dens || 4000, F = dens / 4000;   // точек на м²
  const push = (x, y, z, c, tag, tc) => { X.push(x, y, z); C.push(c[0], c[1], c[2]); T.push(tag); TC.push(tc[0], tc[1], tc[2]); };
  const along = (x, y, z, d) => { const dx = x - S[0], dy = y - S[1], dz = z - S[2], L = Math.hypot(dx, dy, dz); return [x + dx / L * d, y + dy / L * d, z + dz / L * d]; };
  const brick = (x, z) => { const row = Math.floor(z / 0.075), off = (row & 1) * 0.125, mortarH = (z % 0.075) < 0.012, mortarV = ((x + off) % 0.25) < 0.012; return (mortarH || mortarV) ? [190, 185, 175] : [150 + ((row * 7) % 20), 60, 45]; };
  const tile = (x, y) => ((x % 0.3) < 0.01 || (y % 0.3) < 0.01) ? [60, 60, 60] : [200, 200, 195];
  const surf = (x, y, z, tc, tag, nrm) => {
    const r = rnd();
    if (r < 0.10) { const p = along(x, y, z, -(0.01 + rnd() * 0.07)); push(p[0], p[1], p[2], [235, 240, 250], 5, tc); return; }   // белая пыль перед поверхностью
    const p = along(x, y, z, g() * sig); const c = [tc[0] + g() * 8, tc[1] + g() * 8, tc[2] + g() * 8]; push(p[0], p[1], p[2], c, tag, tc);
  };
  for (let i = 0; i < 6 * 3 * dens; i++) { const x = rnd() * 6, z = rnd() * 3; surf(x, 0, z, brick(x, z), 0); }
  for (let i = 0; i < 6 * 4 * dens; i++) { const x = rnd() * 6, y = -4 + rnd() * 4; surf(x, y, 0, tile(x + 10, y + 10), 0); }
  // арматура: 12 стержней Ø2 см из стены наклонно вперёд-вверх, длина 1 м
  for (let b = 0; b < 12; b++) { const x0 = 0.6 + b * 0.4, z0 = 2.2; for (let i = 0; i < 700 * F; i++) { const s = rnd(), a = rnd() * Math.PI * 2; const cx = x0 + 0.1 * s, cy = -0.9 * s, cz = z0 + 0.45 * s; surf(cx + 0.01 * Math.cos(a), cy, cz + 0.01 * Math.sin(a), [70, 80, 160], 1); } }
  // рама: стойки 8×8 см в x=1 и x=5 (y=-2), ригель на высоте 2,4 м
  const tube = (ax, ay, az, bx, by, bz, n) => { for (let i = 0; i < n; i++) { const s = rnd(), side = Math.floor(rnd() * 4), u = rnd() - 0.5; let px = ax + (bx - ax) * s, py = ay + (by - ay) * s, pz = az + (bz - az) * s;
    const vert = Math.abs(bz - az) > 0.5; if (vert) { if (side === 0) { px += 0.04; py += u * 0.08; } else if (side === 1) { px -= 0.04; py += u * 0.08; } else if (side === 2) { py += 0.04; px += u * 0.08; } else { py -= 0.04; px += u * 0.08; } }
    else { if (side === 0) { pz += 0.04; py += u * 0.08; } else if (side === 1) { pz -= 0.04; py += u * 0.08; } else if (side === 2) { py += 0.04; pz += u * 0.08; } else { py -= 0.04; pz += u * 0.08; } }
    surf(px, py, pz, [40, 45, 50], 1); } };
  tube(1, -2, 0, 1, -2, 2.4, 6000 * F); tube(5, -2, 0, 5, -2, 2.4, 6000 * F); tube(1, -2, 2.4, 5, -2, 2.4, 9000 * F);
  // «лучи» за краями рамы: точки между стойкой и стеной на линии взгляда
  for (let i = 0; i < 4000 * F; i++) { const xs = rnd() < 0.5 ? 1 : 5, z = rnd() * 2.4, side = rnd() < 0.5 ? -0.04 : 0.04; const p0 = [xs + side, -2, z]; const t = 0.05 + rnd() * 0.9;
    const dx = p0[0] - S[0], dy = p0[1] - S[1], dz = p0[2] - S[2]; const sw = (0 - S[1]) / dy; const p = [S[0] + dx * (1 + (sw - 1) * t), S[1] + dy * (1 + (sw - 1) * t), S[2] + dz * (1 + (sw - 1) * t)]; push(p[0], p[1], p[2], [100, 90, 90], 7, [0, 0, 0]); }
  // кабель на полу
  for (let i = 0; i < 3000 * F; i++) { const s = rnd() * 5, a = rnd() * Math.PI; surf(0.5 + s, -3 + 0.3 * Math.sin(s * 2), 0.01 + 0.01 * Math.sin(a), [200, 30, 30], 1); }
  for (let i = 0; i < 0.02 * X.length / 3; i++) push(rnd() * 6, -4 + rnd() * 4, rnd() * 3, [150, 150, 160], 6, [0, 0, 0]);
  return { X: Float64Array.from(X), C: Float32Array.from(C), T: Uint8Array.from(T), TC: Float32Array.from(TC), n: T.length };
}
module.exports = { yard, surfaces, writeLas, pathAt };
