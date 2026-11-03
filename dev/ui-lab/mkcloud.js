// Генератор синтетического облака «комната» (binary PLY xyz float + rgb uchar) для проверки интерфейса.
const fs = require('fs');
let seed = 12345; const rnd = () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296;
const W = 6, D = 4, H = 2.8, pts = [];
const add = (x, y, z, r, g, b) => pts.push([x + (rnd() - .5) * .006, y + (rnd() - .5) * .006, z + (rnd() - .5) * .006, r, g, b]);
const N = 300000;
for (let i = 0; i < N; i++) {
  const t = rnd(), u = rnd(), v = rnd();
  if (t < .28) add(u * W, 0, v * D, 150 + rnd() * 30, 140 + rnd() * 25, 125 + rnd() * 20);              // пол
  else if (t < .4) add(u * W, H, v * D, 225, 225, 220);                                                 // потолок
  else if (t < .52) add(u * W, v * H, 0, 210, 205, 195);                                                // стена S
  else if (t < .64) { const x = u * W; if (x > 2.2 && x < 3.1 && v * H < 2.05) continue; add(x, v * H, D, 205, 210, 215); } // стена N с проёмом
  else if (t < .76) add(0, v * H, u * D, 215, 200, 190);                                                // стена W
  else if (t < .88) add(W, v * H, u * D, 195, 205, 210);                                                // стена E
  else if (t < .94) { const f = rnd(); add(4.2 + u * 1.2, f * 0.75, 1.0 + v * 1.4, 90, 70 + f * 50, 50); } // стол/шкаф
  else add(1.0 + u * .6, v * 1.6, 3.0 + rnd() * .5, 60, 90, 140);                                        // колонна/стеллаж
}
const header = `ply\nformat binary_little_endian 1.0\nelement vertex ${pts.length}\nproperty float x\nproperty float y\nproperty float z\nproperty uchar red\nproperty uchar green\nproperty uchar blue\nend_header\n`;
const buf = Buffer.alloc(header.length + pts.length * 15); buf.write(header, 0, 'ascii');
let o = header.length;
for (const p of pts) { buf.writeFloatLE(p[0], o); buf.writeFloatLE(p[1], o + 4); buf.writeFloatLE(p[2], o + 8); buf[o + 12] = p[3] | 0; buf[o + 13] = p[4] | 0; buf[o + 14] = p[5] | 0; o += 15; }
const out = process.env.OUT || require('path').join(__dirname, 'room.ply'); fs.writeFileSync(out, buf);
console.log(out, pts.length, 'points', buf.length, 'bytes');
