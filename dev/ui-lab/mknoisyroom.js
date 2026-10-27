// Шумная синтетическая комната для лаборатории обработки облака (не часть продукта).
//   OUT=/data/work/noisy-room.ply SIGMA=0.006 DOUBLE=0.04 SPACING=0.02 node mknoisyroom.js
const fs = require('fs'), { room } = require('../../test/helpers/synth-room.js');
const S = room({ spacing: +(process.env.SPACING || 0.02), sigma: +(process.env.SIGMA || 0.006), double: +(process.env.DOUBLE || 0.04), flying: +(process.env.FLYING || 600) });
const n = S.pos.length / 3, shade = [[180, 150, 120], [120, 150, 190], [150, 150, 150], [210, 210, 200], [60, 60, 60], [255, 40, 40], [160, 190, 140]];
const header = `ply\nformat binary_little_endian 1.0\nelement vertex ${n}\nproperty float x\nproperty float y\nproperty float z\nproperty uchar red\nproperty uchar green\nproperty uchar blue\nend_header\n`;
const buf = Buffer.alloc(header.length + n * 15); buf.write(header, 0, 'ascii');
let o = header.length;
for (let i = 0; i < n; i++) { buf.writeFloatLE(S.pos[i * 3], o); buf.writeFloatLE(S.pos[i * 3 + 1], o + 4); buf.writeFloatLE(S.pos[i * 3 + 2], o + 8); const c = shade[S.lab[i]]; buf[o + 12] = c[0]; buf[o + 13] = c[1]; buf[o + 14] = c[2]; o += 15; }
const out = process.env.OUT || '/data/work/noisy-room.ply'; fs.writeFileSync(out, buf); console.log(out, n, 'points');
