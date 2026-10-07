// Синтетическая «аудиторская» сцена для проверки измерений (не часть продукта): известные размеры, шум 2 мм, шаг 8 мм.
// Комната X 0..6, Y 0..2,8 (вверх), Z 0..4; колонна 0,4×0,4 (X 4,5..4,9, Z 2,6..3,0); труба Ø220 вдоль X (центр Y 1,6, Z 1,0,
// дуга ±100° от +Z, X 0,8..5,2); «далёкая коробка» на X 150..155 растягивает сцену до ~155 м (как большой объект: 50 м и более).
// Запуск: OUT=/data/work/audit.ply node mkaudit.js
const fs = require('fs');
let seed = 20240607; const rnd = () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296;
const gauss = () => (rnd() + rnd() + rnd() + rnd() - 2) * 1.7320508;   // σ = 1
const STEP = 0.008, SIGMA = 0.002;
const N = []; // x,y,z,r,g,b
const push = (x, y, z, c) => N.push(x, y, z, c[0], c[1], c[2]);
const inCol = (x, z) => x > 4.45 && x < 4.95 && z > 2.55 && z < 3.05;
// прямоугольник P0 + s·U + t·V, шум — по нормали n
function quad(P0, U, V, n, c, step, skip) {
  const lu = Math.hypot(...U), lv = Math.hypot(...V), nu = Math.max(1, Math.round(lu / step)), nv = Math.max(1, Math.round(lv / step));
  for (let i = 0; i <= nu; i++) for (let j = 0; j <= nv; j++) {
    const s = (i + (rnd() - .5) * .25) / nu, t = (j + (rnd() - .5) * .25) / nv, e = gauss() * SIGMA;
    const p = [P0[0] + U[0] * s + V[0] * t + n[0] * e, P0[1] + U[1] * s + V[1] * t + n[1] * e, P0[2] + U[2] * s + V[2] * t + n[2] * e];
    if (skip && skip(p)) continue;
    push(p[0], p[1], p[2], c);
  }
}
const col = (b) => [b + ((rnd() * 8) | 0), b + 4 + ((rnd() * 8) | 0), b + 8];
quad([0, 0, 0], [6, 0, 0], [0, 0, 4], [0, 1, 0], [150, 140, 125], STEP, (p) => inCol(p[0], p[2]));          // пол
quad([0, 2.8, 0], [6, 0, 0], [0, 0, 4], [0, -1, 0], [225, 225, 220], STEP, (p) => inCol(p[0], p[2]));       // потолок
quad([0, 0, 0], [6, 0, 0], [0, 2.8, 0], [0, 0, 1], [210, 205, 195], STEP);                                  // стена S (z=0)
quad([0, 0, 4], [6, 0, 0], [0, 2.8, 0], [0, 0, -1], [205, 210, 215], STEP);                                 // стена N (z=4)
quad([0, 0, 0], [0, 0, 4], [0, 2.8, 0], [1, 0, 0], [215, 200, 190], STEP);                                  // стена W (x=0)
quad([6, 0, 0], [0, 0, 4], [0, 2.8, 0], [-1, 0, 0], [195, 205, 210], STEP);                                 // стена E (x=6)
quad([4.5, 0, 2.6], [0, 0, 0.4], [0, 2.8, 0], [-1, 0, 0], [90, 110, 150], STEP);                            // колонна: грань x=4,5
quad([4.9, 0, 2.6], [0, 0, 0.4], [0, 2.8, 0], [1, 0, 0], [90, 110, 150], STEP);                             // колонна: грань x=4,9
quad([4.5, 0, 2.6], [0.4, 0, 0], [0, 2.8, 0], [0, 0, -1], [90, 110, 150], STEP);                            // колонна: грань z=2,6
quad([4.5, 0, 3.0], [0.4, 0, 0], [0, 2.8, 0], [0, 0, 1], [90, 110, 150], STEP);                             // колонна: грань z=3,0
// труба: Ø220 вдоль X, видна дуга ±100° от +Z (со стороны комнаты)
{ const R = 0.11, cy = 1.6, cz = 1.0, arc = 200 * Math.PI / 180, nx = Math.round(4.4 / STEP), na = Math.round(arc * R / STEP);
  for (let i = 0; i <= nx; i++) for (let j = 0; j <= na; j++) {
    const x = 0.8 + 4.4 * (i + (rnd() - .5) * .25) / nx, ph = -arc / 2 + arc * (j + (rnd() - .5) * .25) / na, r = R + gauss() * SIGMA;
    push(x, cy + r * Math.sin(ph), cz + r * Math.cos(ph), [170, 60 + ((rnd() * 8) | 0), 50]);
  } }
// далёкая коробка X 150..155, Y 0..3, Z 0..5 — редкая сетка (5 см)
{ const s = 0.05, c = [120, 120, 120], X0 = 150, X1 = 155;
  quad([X0, 0, 0], [5, 0, 0], [0, 0, 5], [0, 1, 0], c, s); quad([X0, 3, 0], [5, 0, 0], [0, 0, 5], [0, -1, 0], c, s);
  quad([X0, 0, 0], [5, 0, 0], [0, 3, 0], [0, 0, 1], c, s); quad([X0, 0, 5], [5, 0, 0], [0, 3, 0], [0, 0, -1], c, s);
  quad([X0, 0, 0], [0, 0, 5], [0, 3, 0], [1, 0, 0], c, s); quad([X1, 0, 0], [0, 0, 5], [0, 3, 0], [-1, 0, 0], c, s); }
const n = N.length / 6;
const header = `ply\nformat binary_little_endian 1.0\nelement vertex ${n}\nproperty float x\nproperty float y\nproperty float z\nproperty uchar red\nproperty uchar green\nproperty uchar blue\nend_header\n`;
const buf = Buffer.alloc(header.length + n * 15); buf.write(header, 0, 'ascii');
let o = header.length;
for (let i = 0; i < n; i++) { const b = i * 6; buf.writeFloatLE(N[b], o); buf.writeFloatLE(N[b + 1], o + 4); buf.writeFloatLE(N[b + 2], o + 8); buf[o + 12] = N[b + 3]; buf[o + 13] = N[b + 4]; buf[o + 14] = N[b + 5]; o += 15; }
const out = process.env.OUT || '/data/work/audit.ply'; fs.writeFileSync(out, buf);
console.log(out, n, 'points', buf.length, 'bytes');
