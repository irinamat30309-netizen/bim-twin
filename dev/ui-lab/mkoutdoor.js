// Синтетический «уличный» скан для лаборатории и тестов (не часть продукта): виртуальный лазерный сканер (шаговая сетка лучей) снимает
// сцену из примитивов: плотность падает с расстоянием (как у настоящих сканеров), есть тени и переотражения — то, чего нет у равномерных облаков.
// Сцена: уклон земли, здания, забор, столбы и тонкие провода, деревья (объёмная крона), машины, ящики, тумбы, колонна ростом с человека и ЛЮДИ.
// Метки: 0 — полезные точки (сцена), 1 — шум (пыль, «комочки», краевые ореолы, переотражения под землёй), 2 — люди.
//   OUT=/data/work/outdoor.ply ANG=0.12 node mkoutdoor.js        (в тестах: require('./mkoutdoor').generate({ang:0.2}))
// Координаты исходные Z-up (как у съёмки); toViewer() переводит в Y-up окна: [x, z, -y].
const fs = require('fs');
function rng(seed) { let s = (seed >>> 0) || 1; return () => { s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0; return s / 4294967296; }; }
function gauss(r) { return Math.sqrt(-2 * Math.log(r() + 1e-12)) * Math.cos(2 * Math.PI * r()); }
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
function sphereHit(o, d, c, r) { const oc = [o[0] - c[0], o[1] - c[1], o[2] - c[2]], b = dot(oc, d), cc = dot(oc, oc) - r * r, h = b * b - cc; if (h < 0) return -1; const s = Math.sqrt(h); const t = -b - s; return t > 1e-6 ? t : (-b + s > 1e-6 ? -b + s : -1); }
function capsuleHit(o, d, pa, pb, r) {
  const ba = [pb[0] - pa[0], pb[1] - pa[1], pb[2] - pa[2]], oa = [o[0] - pa[0], o[1] - pa[1], o[2] - pa[2]];
  const baba = dot(ba, ba), bard = dot(ba, d), baoa = dot(ba, oa), rdoa = dot(d, oa), oaoa = dot(oa, oa);
  const a = baba - bard * bard, b = baba * rdoa - baoa * bard, c = baba * oaoa - baoa * baoa - r * r * baba, h = b * b - a * c;
  if (h >= 0) {
    const t = (-b - Math.sqrt(h)) / a, y = baoa + t * bard;
    if (y > 0 && y < baba && t > 1e-6) return t;
    const oc = y <= 0 ? oa : [o[0] - pb[0], o[1] - pb[1], o[2] - pb[2]], b2 = dot(d, oc), c2 = dot(oc, oc) - r * r, h2 = b2 * b2 - c2;
    if (h2 > 0) { const t2 = -b2 - Math.sqrt(h2); if (t2 > 1e-6) return t2; }
  }
  return -1;
}
function boxHit(o, d, mn, mx) {
  let t0 = 1e-6, t1 = Infinity;
  for (let k = 0; k < 3; k++) {
    if (Math.abs(d[k]) < 1e-12) { if (o[k] < mn[k] || o[k] > mx[k]) return -1; continue; }
    let a = (mn[k] - o[k]) / d[k], b = (mx[k] - o[k]) / d[k]; if (a > b) { const t = a; a = b; b = t; }
    if (a > t0) t0 = a; if (b < t1) t1 = b; if (t0 > t1) return -1;
  }
  return t0;
}

function buildScene(opt) {
  const R = rng(opt.seed || 7), slope = opt.slope == null ? 0.03 : opt.slope, gz = (x) => slope * x, E = [], people = [];
  const box = (x0, y0, x1, y1, h, col, cls) => E.push({ cls: cls || 0, col, bs: [(x0 + x1) / 2, (y0 + y1) / 2, gz((x0 + x1) / 2) + h / 2, Math.hypot(x1 - x0, y1 - y0, h) / 2 + 0.1],
    parts: [{ t: 'box', mn: [x0, y0, Math.min(gz(x0), gz(x1)) - 0.05], mx: [x1, y1, Math.max(gz(x0), gz(x1)) + h] }] });
  const cap = (x, y, z0, z1, r, col, cls) => E.push({ cls: cls || 0, col, bs: [x, y, (z0 + z1) / 2, (z1 - z0) / 2 + r + 0.1], parts: [{ t: 'cap', a: [x, y, z0], b: [x, y, z1], r }] });
  // здания, фасады с «окнами» (выступающие рамы), забор
  box(22, -12, 52, 22, 13, [190, 175, 150]); box(-48, 18, -18, 40, 9, [170, 150, 135]); box(8, 38, 30, 52, 7, [150, 150, 160]);
  box(-30, -22, -29.6, 28, 2.2, [120, 120, 125]);
  for (let k = 0; k < 6; k++) box(21.7, -9 + k * 5, 22, -7.2 + k * 5, 0.9 + 3.5, [95, 95, 105]);   // оконные рамы-ленты на фасаде
  // столбы и провода
  const poles = [];
  for (let k = 0; k < 8; k++) { const x = -34 + k * 11, y = -8 + (k % 2) * 0.5; poles.push([x, y]); cap(x, y, gz(x), gz(x) + 6.2, 0.13, [70, 70, 75]); }
  for (let k = 0; k + 1 < poles.length; k++) for (const dz of [5.7, 5.2]) {
    const a = poles[k], b = poles[k + 1];
    E.push({ cls: 0, col: [20, 20, 20], bs: [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, gz((a[0] + b[0]) / 2) + dz, 6.5], parts: [{ t: 'cap', a: [a[0], a[1], gz(a[0]) + dz], b: [b[0], b[1], gz(b[0]) + dz - 0.35], r: 0.011 }] });
  }
  // деревья: ствол + объёмная крона (прозрачный шар)
  for (const [x, y, hh, rc] of [[-12, 12, 3, 2.6], [5, 14, 3.4, 3], [-20, -14, 2.8, 2.4], [14, -20, 3.2, 2.8], [34, 30, 3, 2.6]]) {
    cap(x, y, gz(x), gz(x) + hh, 0.17, [100, 80, 60]);
    E.push({ cls: 0, col: [70, 120, 60], vol: true, bs: [x, y, gz(x) + hh + rc * 0.7, rc], parts: [{ t: 'vol', c: [x, y, gz(x) + hh + rc * 0.7], r: rc }] });
  }
  // машины, ящики, тумбы, колонна
  box(10, -4, 14.5, -2.4, 1.5, [60, 70, 140]); box(-6, -12, -1.5, -10.4, 1.4, [150, 40, 40]); box(30, 4, 34.5, 5.6, 1.6, [210, 210, 210]);
  box(-3, 6, -2, 7, 1.5, [150, 120, 70]); box(1, 7.5, 1.6, 8.1, 1.1, [60, 100, 70]);
  cap(3, -6, gz(3), gz(3) + 0.9, 0.12, [220, 180, 40]); cap(4.5, -6, gz(4.5), gz(4.5) + 0.9, 0.12, [220, 180, 40]);
  cap(-9, -3, gz(-9), gz(-9) + 1.75, 0.26, [200, 200, 195]);                                  // колонна ростом с человека
  cap(18, 8, gz(18), gz(18) + 2.4, 0.04, [60, 60, 60]); box(17.6, 7.9, 18.4, 8.1, 0.6, [30, 90, 160]); E[E.length - 1].parts[0].mn[2] += 1.9; E[E.length - 1].parts[0].mx[2] += 1.9 - 0.0; // знак на стойке
  // люди
  function person(x, y, h, yaw, opt2) {
    opt2 = opt2 || {}; const g = gz(x), sx = -Math.sin(yaw), sy = Math.cos(yaw), fx = Math.cos(yaw), fy = Math.sin(yaw), sc = h / 1.75;
    const skin = [215, 170, 140], shirt = opt2.shirt || [60, 90, 170], trousers = opt2.trousers || [40, 40, 50], parts = [];
    const P = (dx, dy, z) => [x + sx * dx + fx * dy, y + sy * dx + fy * dy, g + z * sc];
    const stride = opt2.walk ? 0.3 : 0;
    parts.push({ t: 'cap', a: P(0.1, stride, 0.07), b: P(0.09, 0, 0.88), r: 0.075 * sc, col: trousers }, { t: 'cap', a: P(-0.1, -stride, 0.07), b: P(-0.09, 0, 0.88), r: 0.075 * sc, col: trousers });
    parts.push({ t: 'cap', a: P(0, 0, 0.92), b: P(0, 0, 1.38), r: 0.165 * sc, col: shirt });
    parts.push({ t: 'cap', a: P(0.24, opt2.walk ? 0.12 : 0, 1.32), b: P(0.25, opt2.walk ? -0.1 : 0, 0.92), r: 0.045 * sc, col: shirt }, { t: 'cap', a: P(-0.24, opt2.walk ? -0.12 : 0, 1.32), b: P(-0.25, opt2.walk ? 0.1 : 0, 0.92), r: 0.045 * sc, col: shirt });
    parts.push({ t: 'cap', a: P(0, 0, 1.44), b: P(0, 0, 1.5), r: 0.05 * sc, col: skin }, { t: 'sph', c: P(0, 0, 1.62), r: 0.105 * sc, col: skin });
    E.push({ cls: 2, col: shirt, bs: [x, y, g + 0.95 * sc, 1.3 * sc], parts, person: true });
    people.push({ x, y, h, walk: !!opt2.walk });
  }
  person(6, -2, 1.78, 0.4); person(-4, -6, 1.7, 2.0, { shirt: [180, 50, 50] }); person(14, 4, 1.65, 1.1, { walk: true, shirt: [60, 130, 80] });
  person(-16, 2, 1.85, 3.4, { shirt: [30, 30, 30], trousers: [30, 40, 70] }); person(24, -16, 1.72, 0, { walk: true }); person(-26, -4, 1.6, 1.2, { shirt: [220, 200, 60] });
  person(9, 12, 1.75, 0.5); person(9.55, 12.1, 1.68, 2.4, { shirt: [150, 60, 150] });          // двое рядом (почти касаются)
  person(20.5, 2, 1.8, 2.5, { shirt: [90, 90, 90] });                                          // у стены здания (≈ 1,5 м до фасада)
  person(-8, 10, 1.7, 0.2, { shirt: [100, 160, 200] });
  return { E, people, gz, slope };
}

function generate(o) {
  o = o || {};
  const ang = (o.ang || 0.12) * Math.PI / 180, R = rng((o.seed || 7) + 1000), S = buildScene(o), E = S.E, gz = S.gz, slope = S.slope;
  const scanners = o.scanners || [[0, 0], [26, -16]];
  const P = [], C = [], L = [], K = [], maxR = o.maxRange || 90, nrm = [-slope, 0, 1], nl = Math.hypot(...nrm);
  let kind = 0; const push = (x, y, z, col, lab) => { P.push(x, y, z); C.push(col[0], col[1], col[2]); L.push(lab); K.push(lab === 1 ? kind : 0); };
  for (const sc of scanners) {
    const so = [sc[0], sc[1], gz(sc[0]) + 1.6], el0 = -62 * Math.PI / 180, el1 = 62 * Math.PI / 180;
    for (let el = el0; el <= el1; el += ang) {
      const ce = Math.cos(el), se = Math.sin(el), azStep = ang / Math.max(0.2, ce);
      for (let az = 0; az < 2 * Math.PI; az += azStep) {
        const d = [ce * Math.cos(az), ce * Math.sin(az), se];
        let best = maxR, hit = null;
        // земля
        const dn = (d[0] * nrm[0] + d[2]) / nl; if (dn < -1e-6) { const tt = -((so[0] * nrm[0] + so[2]) / nl) / dn; if (tt > 0 && tt < best) { best = tt; hit = { cls: 0, col: [118 + 20 * R(), 124 + 18 * R(), 100 + 12 * R()], g: true }; } }
        for (const e of E) {
          const bsT = sphereHit(so, d, e.bs, e.bs[3]); if (bsT < 0 && Math.hypot(so[0] - e.bs[0], so[1] - e.bs[1], so[2] - e.bs[2]) > e.bs[3]) continue;
          for (const p of e.parts) {
            let t = -1;
            if (p.t === 'box') t = boxHit(so, d, p.mn, p.mx); else if (p.t === 'cap') t = capsuleHit(so, d, p.a, p.b, p.r);
            else if (p.t === 'sph') t = sphereHit(so, d, p.c, p.r);
            else if (p.t === 'vol') {
              const oc = [so[0] - p.c[0], so[1] - p.c[1], so[2] - p.c[2]], b = dot(oc, d), cc = dot(oc, oc) - p.r * p.r, h = b * b - cc;
              if (h > 0) { const s = Math.sqrt(h), ta = Math.max(1e-6, -b - s), tb = -b + s, chord = tb - ta; if (chord > 0 && R() < 1 - Math.exp(-0.9 * chord)) t = ta + R() * chord; }
            }
            if (t > 0 && t < best) { best = t; hit = { cls: e.cls, col: p.col || e.col, person: !!e.person, pole: p.r && p.r < 0.2 && !e.person }; }
          }
        }
        if (!hit) continue;
        const sig = 0.002 + 0.0001 * best, t = best + sig * gauss(R);
        const x = so[0] + d[0] * t, y = so[1] + d[1] * t; let z = so[2] + d[2] * t;
        if (hit.g) z += 0.004 * gauss(R);
        const cj = hit.col, k = 0.9 + 0.2 * R();
        push(x, y, z, [Math.min(255, cj[0] * k), Math.min(255, cj[1] * k), Math.min(255, cj[2] * k)], hit.cls === 2 ? 2 : 0);
        if ((hit.person || hit.pole) && R() < 0.015) { const t2 = t * (1.02 + R() * 1.2); kind = 5; push(so[0] + d[0] * t2, so[1] + d[1] * t2, so[2] + d[2] * t2, [120, 120, 120], 1); kind = 0; }  // краевой ореол
      }
    }
  }
  const nHit = L.length; kind = 1;
  // шум: пыль у сканеров, «комочки», переотражения под землёй, дальние выбросы
  const nDust = Math.round(nHit * (o.dust == null ? 0.0006 : o.dust));
  for (let i = 0; i < nDust; i++) { const sc = scanners[(R() * scanners.length) | 0], r = 2 + 24 * Math.sqrt(R()), a = R() * 6.2832, x = sc[0] + r * Math.cos(a), y = sc[1] + r * Math.sin(a); push(x, y, gz(x) + 0.3 + R() * 6, [150, 150, 150], 1); }
  kind = 2;
  for (let i = 0; i < 70; i++) {
    const x = -30 + 70 * R(), y = -25 + 50 * R(), z = gz(x) + 0.8 + 3 * R(), sg = 0.03 + 0.05 * R(), m = 5 + ((R() * 36) | 0);
    for (let k = 0; k < m; k++) push(x + sg * gauss(R), y + sg * gauss(R), z + sg * gauss(R), [140, 140, 140], 1);
  }
  kind = 3;
  for (let i = 0; i < 200; i++) { const x = -30 + 70 * R(), y = -25 + 50 * R(); push(x, y, gz(x) - 0.6 - 2.5 * R(), [110, 110, 110], 1); }
  kind = 4;
  for (let i = 0; i < 40; i++) { const a = R() * 6.2832, r = 120 + 200 * R(); push(r * Math.cos(a), r * Math.sin(a), 5 + 30 * R(), [100, 100, 100], 1); }
  return { pos: new Float32Array(P), col: new Uint8Array(C), lab: new Uint8Array(L), kind: new Uint8Array(K), people: S.people, hits: nHit };
}
function toViewer(pos) { const n = pos.length / 3, out = new Float32Array(pos.length); for (let i = 0; i < n; i++) { out[i * 3] = pos[i * 3]; out[i * 3 + 1] = pos[i * 3 + 2]; out[i * 3 + 2] = -pos[i * 3 + 1]; } return out; }
function writePly(file, S) {
  const n = S.pos.length / 3, header = `ply\nformat binary_little_endian 1.0\nelement vertex ${n}\nproperty float x\nproperty float y\nproperty float z\nproperty uchar red\nproperty uchar green\nproperty uchar blue\nend_header\n`;
  const buf = Buffer.alloc(header.length + n * 15); buf.write(header, 0, 'ascii'); let o = header.length;
  for (let i = 0; i < n; i++) { buf.writeFloatLE(S.pos[i * 3], o); buf.writeFloatLE(S.pos[i * 3 + 1], o + 4); buf.writeFloatLE(S.pos[i * 3 + 2], o + 8); buf[o + 12] = S.col[i * 3]; buf[o + 13] = S.col[i * 3 + 1]; buf[o + 14] = S.col[i * 3 + 2]; o += 15; }
  fs.writeFileSync(file, buf);
}
module.exports = { generate, toViewer, writePly };
if (require.main === module) {
  const t0 = Date.now(), S = generate({ ang: +(process.env.ANG || 0.12), seed: +(process.env.SEED || 7) }), out = process.env.OUT || '/data/work/outdoor.ply';
  writePly(out, S); fs.writeFileSync(out.replace(/\.ply$/, '.labels.bin'), S.lab); fs.writeFileSync(out.replace(/\.ply$/, '.json'), JSON.stringify({ people: S.people, hits: S.hits }));
  const cnt = [0, 0, 0]; for (const v of S.lab) cnt[v]++;
  console.log(out, S.pos.length / 3, 'точек; сцена', cnt[0], 'шум', cnt[1], 'люди', cnt[2], '·', Date.now() - t0, 'мс');
}
