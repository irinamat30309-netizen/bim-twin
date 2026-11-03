// Быстрый харнесс на реальных данных без браузера: тот же precision-snap.js, индекс по каждой 6-й точке (выборка просмотра).
// Запуск (облако и эталон в репозиторий не входят):
//   LAB_CLOUD=/путь/_1.ply LAB_GT=/путь/gt-targets.json SDS=0.02,0.033,0.052,0.07 node dev/ui-lab/real-node.js
// LAB_CLOUD — бинарный PLY little-endian: x, y, z (float32) и r, g, b (uint8), 15 байт на точку; LAB_GT — эталон {snaps, pairs} в исходных координатах;
// SDS — радиусы захвата, м; OS — промах кликов относительно радиуса (0,55); FLOORSP — нижний порог окна плоскостей в шагах облака, как в просмотре (17; 0 — без порога);
// GROW=0 — без роста плоскостей; JITTER=0 — равномерная выборка вместо случайной; PSFILE — другой вариант precision-snap.js для сравнения.
const fs = require('fs'), path = require('path');
const PS = require(process.env.PSFILE || path.join(__dirname, '..', '..', 'renderer', 'precision-snap.js'));
const LC = require(path.join(__dirname, '..', '..', 'las-core.js'));   // та же выборка, что у просмотра (JITTER=0 — прежний равномерный шаг)
const JIT = process.env.JITTER !== '0';
if (!process.env.LAB_CLOUD || !process.env.LAB_GT) { console.error('Задайте LAB_CLOUD (PLY) и LAB_GT (эталон JSON) — см. начало файла'); process.exit(2); }
const file = process.env.LAB_CLOUD, GT = JSON.parse(fs.readFileSync(process.env.LAB_GT, 'utf8'));
const STRIDE = +(process.env.STRIDE || 6);
function load(file, stride) {
  const fd = fs.openSync(file, 'r'), head = Buffer.alloc(4096); fs.readSync(fd, head, 0, 4096, 0);
  const hs = head.toString('latin1'), he = hs.indexOf('end_header'), off = hs.indexOf('\n', he) + 1;
  const nv = +/element vertex (\d+)/.exec(hs)[1], rec = 15, CH = 300000, buf = Buffer.alloc(CH * rec);
  const mn = [1e9, 1e9, 1e9], mx = [-1e9, -1e9, -1e9], out = new Float32Array(Math.ceil(nv / stride) * 3); let m = 0;
  for (let i = 0; i < nv; i += CH) {
    const k = Math.min(CH, nv - i); fs.readSync(fd, buf, 0, k * rec, off + i * rec);
    for (let j = 0; j < k; j++) {
      const x = buf.readFloatLE(j * rec), y = buf.readFloatLE(j * rec + 4), z = buf.readFloatLE(j * rec + 8);
      if (x < mn[0]) mn[0] = x; if (x > mx[0]) mx[0] = x; if (y < mn[1]) mn[1] = y; if (y > mx[1]) mx[1] = y; if (z < mn[2]) mn[2] = z; if (z > mx[2]) mx[2] = z;
      if (JIT ? LC.keepSampledIndex(i + j, stride) : (i + j) % stride === 0) { out[m * 3] = x; out[m * 3 + 1] = y; out[m * 3 + 2] = z; m++; }
    }
  }
  fs.closeSync(fd); return { pos: out.subarray(0, m * 3), mn, mx, nv };
}
module.exports = { load, PS, GT };

const OS = +(process.env.OS || 0.55);
function evaluate(idx, shift, opts) {
  const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2], sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
  const OFF = [[0, 0, 0], [0.02, 0.02, 0], [-0.02, 0.015, 0.01], [0.01, -0.03, -0.02], [-0.03, -0.01, 0.02], [0.025, 0, -0.025]];
  const near = (c) => { const j = idx.nearest(c[0], c[1], c[2], 0.15); return j < 0 ? null : [idx.pos[j * 3], idx.pos[j * 3 + 1], idx.pos[j * 3 + 2]]; };
  const toO = (p) => [p[0] - shift[0], p[1] - shift[1], p[2] - shift[2]];
  const R = { snaps: {}, pairs: {} }, cache = {};
  const snapAt = (id, i) => {
    const key = id + '#' + i; if (cache[key]) return cache[key];
    const g = GT.snaps[id], o = OFF[i % OFF.length].map((v) => v * OS), c = [g.ideal[0] + shift[0] + o[0], g.ideal[1] + shift[1] + o[1], g.ideal[2] + shift[2] + o[2]], seed = near(c);
    if (!seed) return null;
    const t0 = process.hrtime.bigint(); const FL = process.env.FLOORSP == null ? 17 : +process.env.FLOORSP; const r = PS.snap(seed, idx, { snapDist: opts.sd, radius: FL > 0 ? Math.max(2.4 * opts.sd, FL * (idx.spacing || 0.006)) : undefined, grow: opts.grow !== false }); r.ms = Number(process.hrtime.bigint() - t0) / 1e6; r.seedRaw = seed;   // окно плоскостей как в просмотре (webgl-viewer._precisionSnapAt): не меньше FLOORSP шагов; FLOORSP=0 — прежнее поведение
    return (cache[key] = r);
  };
  const errOf = (g, r) => {
    const d = sub(toO(r.point), (r.contour && g.gtC) ? g.gtC : g.gt);
    if (g.kind === 'plane') return Math.abs(dot(d, g.n));
    if (g.kind === 'edge') { const al = dot(d, g.dir); return Math.hypot(d[0] - g.dir[0] * al, d[1] - g.dir[1] * al, d[2] - g.dir[2] * al); }
    return Math.hypot(d[0], d[1], d[2]);
  };
  for (const id of Object.keys(GT.snaps)) {
    const g = GT.snaps[id], rows = [];
    for (let i = 0; i < OFF.length; i++) { const r = snapAt(id, i); if (!r) continue; rows.push({ kind: r.kind, contour: !!r.contour, err: errOf(g, r), ms: r.ms, sigma: r.sigma, count: r.count, quality: r.quality }); }
    R.snaps[id] = { expect: g.kind, rows };
  }
  for (const pr of GT.pairs) {
    const rows = [];
    for (let i = 0; i < OFF.length; i++) {
      const ra = snapAt(pr.a, i), rb = snapAt(pr.b, (i + 3) % OFF.length); if (!ra || !rb) continue;
      const gp = PS.pairGap(ra, rb); const eu = Math.hypot(rb.point[0] - ra.point[0], rb.point[1] - ra.point[1], rb.point[2] - ra.point[2]);
      const raw = Math.hypot(rb.seedRaw[0] - ra.seedRaw[0], rb.seedRaw[1] - ra.seedRaw[1], rb.seedRaw[2] - ra.seedRaw[2]);
      rows.push({ value: gp ? gp.value : eu, how: gp ? gp.kind : 'точки', unc: gp ? gp.uncertainty : null, raw, ka: ra.kind, kb: rb.kind, ca: !!ra.contour, cb: !!rb.contour });
    }
    R.pairs[pr.name] = { gt: pr.gt, gtC: pr.gtC, rows };
  }
  return R;
}
function report(R, title) {
  const mm = (x) => (x * 1000).toFixed(2).replace('.', ',');
  console.log('\n=== ' + title + ' ===');
  for (const id of Object.keys(R.snaps)) {
    const s = R.snaps[id], r = s.rows; if (!r.length) { console.log(id.padEnd(11), 'нет точек'); continue; }
    const isC = GT.snaps[id].contour, good = (x) => x.kind === s.expect, ok = r.filter(good).length, es = r.filter(good).map((x) => x.err), max = es.length ? Math.max.apply(null, es) : NaN, mean = es.length ? es.reduce((a, b) => a + b, 0) / es.length : NaN;
    console.log(id.padEnd(11), s.expect.padEnd(6), 'тип верный ' + ok + '/' + r.length + (isC ? ' (контур ' + r.filter((x) => x.contour).length + ', по 2 плоскостям ' + r.filter((x) => !x.contour && x.kind === 'edge').length + ')' : '') + ' | ошибка (верный тип) ср ' + mm(mean) + ' макс ' + mm(max) + ' мм | другие типы: ' + r.filter((x) => !good(x)).map((x) => x.kind + (x.contour ? '*' : '')).join(',') + ' | σ ' + mm(r[0].sigma || 0) + ' мм | ' + Math.round(r.reduce((a, x) => a + x.ms, 0) / r.length) + ' мс');
  }
  for (const name of Object.keys(R.pairs)) {
    const p = R.pairs[name], vs = p.rows; if (!vs.length) { console.log(name.padEnd(22), 'нет данных'); continue; }
    const gtOf = (x) => (p.gtC != null && x.ca && x.cb) ? p.gtC : (p.gtC != null && (x.ca !== x.cb) ? (p.gt + p.gtC) / 2 : p.gt), e = vs.map((x) => Math.abs(x.value - gtOf(x))), raw = vs.map((x) => Math.abs(x.raw - gtOf(x)));
    console.log(name.padEnd(22), 'GT ' + p.gt.toFixed(4), '| ошибка ср ' + mm(e.reduce((a, b) => a + b, 0) / e.length) + ' макс ' + mm(Math.max.apply(null, e)) + ' мм | способ ' + Array.from(new Set(vs.map((x) => x.how))).join('/') + ' | «грубо» по кликам ср ' + mm(raw.reduce((a, b) => a + b, 0) / raw.length) + ' мм' + (vs[0].unc != null ? ' | заявл. ±' + mm(vs[0].unc) + ' мм' : ''));
  }
}
function coverage(R) {
  const c = { snaps: { n: 0, k1: 0, k2: 0, k3: 0 }, pairs: { n: 0, k1: 0, k2: 0, k3: 0 } };
  for (const id of Object.keys(R.snaps)) for (const x of R.snaps[id].rows) { if (x.kind !== R.snaps[id].expect || !(x.sigma > 0)) continue; c.snaps.n++; if (x.err <= x.sigma) c.snaps.k1++; if (x.err <= 2 * x.sigma) c.snaps.k2++; if (x.err <= 3 * x.sigma) c.snaps.k3++; }
  for (const name of Object.keys(R.pairs)) { const p = R.pairs[name]; for (const x of p.rows) { if (x.unc == null) continue; const gt = (p.gtC != null && x.ca && x.cb) ? p.gtC : (p.gtC != null && (x.ca !== x.cb) ? (p.gt + p.gtC) / 2 : p.gt), e = Math.abs(x.value - gt); c.pairs.n++; if (e <= x.unc) c.pairs.k1++; if (e <= 2 * x.unc) c.pairs.k2++; if (e <= 3 * x.unc) c.pairs.k3++; } }
  return c;
}
function reportCoverage(R) {
  const c = coverage(R), f = (o) => o.n ? ('в ±1σ ' + Math.round(100 * o.k1 / o.n) + '%, в ±2σ ' + Math.round(100 * o.k2 / o.n) + '%, в ±3σ ' + Math.round(100 * o.k3 / o.n) + '% из ' + o.n) : 'нет';
  console.log('\nпокрытие заявленной погрешности (реальная ошибка относительно ±σ):\n  привязки: ' + f(c.snaps) + '\n  размеры между привязками: ' + f(c.pairs));
}
module.exports.evaluate = evaluate; module.exports.report = report; module.exports.coverage = coverage;
if (require.main === module) {
  let t = Date.now(); const L = load(file, STRIDE); console.log('прочитано', L.pos.length / 3, 'точек за', Date.now() - t, 'мс');
  const shift = [0, 1, 2].map((k) => -(L.mn[k] + L.mx[k]) / 2);
  const pos = new Float32Array(L.pos.length); for (let i = 0; i < pos.length; i++) pos[i] = L.pos[i] + shift[i % 3];
  t = Date.now(); const idx = PS.buildIndex(pos); console.log('индекс', Date.now() - t, 'мс; шаг', (idx.spacing * 1000).toFixed(2), 'мм; ячейка', (idx.cell * 1000).toFixed(1), 'мм');
  for (const sd of (process.env.SDS || '0.033').split(',').map(Number)) { const R = evaluate(idx, shift, { sd, grow: process.env.GROW !== '0' }); report(R, 'радиус захвата ' + (sd * 1000).toFixed(0) + ' мм, рост ' + (process.env.GROW !== '0' ? 'да' : 'нет')); reportCoverage(R); }
}
